// seedQuiz.js
const db = require('./db'); // keep RDS here; use ./dbTimescale only for click
const { DateTime } = require('luxon');
const {
  canvasRequest,
  getAllPages,
  getQuizzesByCourseId,
  extractQuizScoresByUser,
} = require('./utils');

const PT_ZONE = 'America/Los_Angeles';

function resolveWindow(sinceISO, untilISO, now = DateTime.now().setZone(PT_ZONE)) {
  const today4 = now.startOf('day').plus({ hours: 4 });
  const anchor = (now < today4) ? today4.minus({ days: 1 }) : today4;
  const defSince = anchor.minus({ days: 1 });
  const defUntil = anchor;

  const parsedSince = sinceISO ? DateTime.fromISO(sinceISO, { zone: PT_ZONE }) : defSince;
  const parsedUntil = untilISO ? DateTime.fromISO(untilISO, { zone: PT_ZONE }) : defUntil;

  if (!parsedSince.isValid) throw new Error(`Invalid sinceISO: ${sinceISO}`);
  if (!parsedUntil.isValid) throw new Error(`Invalid untilISO: ${untilISO}`);
  if (parsedSince >= parsedUntil) throw new Error(`sinceISO must be < untilISO`);

  return {
    sinceISO: parsedSince.toISO(),
    untilISO: parsedUntil.toISO(),
    sinceLocal: parsedSince.toFormat('yyyy-LL-dd HH:mm ZZZZ'),
    untilLocal: parsedUntil.toFormat('yyyy-LL-dd HH:mm ZZZZ'),
  };
}

// Keep your question list as-is
const QUESTION_LIST = [ /* … your QUESTION_LIST unchanged … */ ];

async function seedQuestionsOnce() {
  const client = await db.quizDb.connect();
  try {
    await client.query('BEGIN');
    for (const { code, prompt } of QUESTION_LIST) {
      await client.query(
        `INSERT INTO questions (code, prompt)
         VALUES ($1, $2)
         ON CONFLICT (code) DO UPDATE SET prompt = EXCLUDED.prompt`,
        [code, prompt]
      );
    }
    const { rows } = await client.query('SELECT id, code FROM questions');
    await client.query('COMMIT');
    return Object.fromEntries(rows.map((r) => [r.code, r.id]));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Pull enrollments as the single source of truth for roster, statuses, and grades. */
async function getCourseEnrollments(courseId) {
  // include[]=user for names; enumerate states so inactive/completed show up
  const url =
    `https://unlv.instructure.com/api/v1/courses/${courseId}/enrollments` +
    `?type[]=StudentEnrollment&state[]=active&state[]=inactive&state[]=completed&state[]=invited&include[]=user`;
  return getAllPages(url);
}

/** Upsert a student and link to course; return db student id */
async function ensureStudent(client, { userId, name, currentScore, dbCourseId, status = 'active' }) {
  const upsert = await client.query(
    `INSERT INTO students (canvas_user_id, name, current_score)
     VALUES ($1, $2, $3)
     ON CONFLICT (canvas_user_id) DO UPDATE
       SET name = EXCLUDED.name,
           current_score = EXCLUDED.current_score
     RETURNING id`,
    [userId, name || '', (typeof currentScore === 'number' ? currentScore : null)]
  );
  const dbStudentId = upsert.rows[0].id;

  await client.query(
    `INSERT INTO student_courses (student_id, course_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (student_id, course_id) DO UPDATE
       SET status = EXCLUDED.status`,
    [dbStudentId, dbCourseId, status || 'active']
  );

  return dbStudentId;
}

/** Upsert previous unposted final scores into external_course_scores */
async function upsertExternalCourseScores(client, {
  canvas_course_id,
  canvas_user_id,
  student_id,
  course_name,
  enrollment_created_at,
  unposted_final_score,
}) {
  await client.query(
    `INSERT INTO external_course_scores
       (canvas_course_id, canvas_user_id, student_id, course_name, enrollment_created_at, unposted_final_score)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (canvas_course_id, canvas_user_id) DO UPDATE
        SET student_id = COALESCE(EXCLUDED.student_id, external_course_scores.student_id),
            course_name = COALESCE(EXCLUDED.course_name, external_course_scores.course_name),
            enrollment_created_at = COALESCE(EXCLUDED.enrollment_created_at, external_course_scores.enrollment_created_at),
            unposted_final_score = EXCLUDED.unposted_final_score`,
    [
      canvas_course_id, 
      canvas_user_id, 
      student_id || null, 
      course_name || null, 
      enrollment_created_at || null, 
      typeof unposted_final_score === 'number' ? unposted_final_score : null,
    ]
  );
}

async function seedExternalScoresForRoster(client, enrollments, studentIdByUserId) {
  // unique user IDs from this course roster
  const userIds = [...new Set(enrollments.map(e => e.user_id).filter(Boolean))];

  for (const userId of userIds) {
    let userEnrollments = []; // save previous enrollments for this user
    try {
      const url =
        `https://unlv.test.instructure.com/api/v1/users/${userId}/enrollments` +
        `?type[]=StudentEnrollment&include[]=total_scores`;
      userEnrollments = await getAllPages(url);
    } catch (err) {
      console.error(`Failed to retrieve enrollments for user ${userId}:`, err);
      continue;
    }

    const dbStudentId = studentIdByUserId[userId] || null;

    for (const enr of userEnrollments) {
      const otherCourseId = enr.course_id;
      if (!otherCourseId) continue;

      const unpostedFinal = 
        enr.grades && typeof enr.grades.unposted_final_score === 'number'
          ? enr.grades.unposted_final_score
          : null;
      
      await upsertExternalCourseScores(client, {
        canvas_course_id: otherCourseId,
        canvas_user_id: userId,
        student_id: dbStudentId,
        course_name: enr.course?.name || null,
        enrollment_created_at: enr.created_at || null,
        unposted_final_score: unpostedFinal,
      });
    }
  }
}

      

/** Seed ONE course in a time window: mirrors seedClick signature */
async function seedQuiz(courseId, sinceISO, untilISO) {
  const { sinceISO: sISO, untilISO: uISO, sinceLocal, untilLocal } = resolveWindow(sinceISO, untilISO);

  // 1) ensure questions exist and get code->id map
  const codeToQuestionId = await seedQuestionsOnce();

  const client = await db.quizDb.connect();
  try {
    await client.query('BEGIN');
    console.log('----- Seeding quiz data for course:', courseId);
    console.log(`Time window PT:   [${sinceLocal} -> ${untilLocal}]`);
    console.log(`Time window ISO:  [${sISO} -> ${uISO}]`);

    // 2) Upsert course
    const courseDetails = await canvasRequest(`courses/${courseId}`);
    const courseName = courseDetails?.data?.name || `Course ${courseId}`;
    const courseUpsert = await client.query(
      `INSERT INTO courses (canvas_course_id, name, is_demo)
       VALUES ($1, $2, false)
       ON CONFLICT (canvas_course_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [courseId, courseName]
    );
    const dbCourseId = courseUpsert.rows[0].id;

    // 3) Roster from ENROLLMENTS ONLY (authoritative for status + grade + user)
    const enrollments = await getCourseEnrollments(courseId);

    // Optional: quick visibility into counts by status
    const statusCounts = enrollments.reduce((acc, e) => {
      const s = e.enrollment_state || e.state || 'unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});
    console.log('Enrollment status counts:', statusCounts);

    // Ensure roster based on enrollments
    const scoreMap = {}; // not strictly needed, but kept if you later reuse
    const studentIdByUserId = {}; // map Canvas user_id → RDS student.id

    for (const enr of enrollments) {
      const uid = enr.user_id;
      const name = enr.user?.name || enr.user?.short_name || '';
      const status = enr.enrollment_state || enr.state || 'active';
      const currentScore = (enr.grades && typeof enr.grades.current_score === 'number')
        ? enr.grades.current_score
        : null;

      if (!uid) continue;

      if (typeof currentScore === 'number') scoreMap[uid] = currentScore;

      const dbStudentId = await ensureStudent(client, {
        userId: uid,
        name,
        currentScore,
        dbCourseId,
        status,
      });

      studentIdByUserId[uid] = dbStudentId;
    }

    await seedExternalScoresForRoster(client, enrollments, studentIdByUserId);

    // 4) Quizzes
    const quizzes = await getQuizzesByCourseId(courseId);
    for (const quiz of quizzes) {
      const quizUpsert = await client.query(
        `INSERT INTO quizzes (canvas_quiz_id, assignment_id, course_id, title, due_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (canvas_quiz_id) DO UPDATE SET
           assignment_id = EXCLUDED.assignment_id,
           title = EXCLUDED.title,
           due_at = EXCLUDED.due_at
         RETURNING id`,
        [quiz.id, quiz.assignment_id, dbCourseId, quiz.title, quiz.due_at]
      );
      const dbQuizId = quizUpsert.rows[0].id;
      console.log('Quiz:', quiz.id, quiz.assignment_id, quiz.title);

      // Fetch quiz questions for answer-id→text mapping
      const questionRes = await canvasRequest(`courses/${courseId}/quizzes/${quiz.id}/questions`);
      const allQuestions = questionRes?.data || [];

      // 5) Submissions (filter to window)
      let submissions = [];
      try {
        submissions = await getAllPages(
          `https://unlv.instructure.com/api/v1/courses/${courseId}/assignments/${quiz.assignment_id}/submissions?include[]=submission_history`
        );
      } catch (err) {
        console.error(`Failed to retrieve submissions for quiz assignment ${quiz.assignment_id}:`, err);
        continue;
      }

      const sTs = DateTime.fromISO(sISO);
      const uTs = DateTime.fromISO(uISO);
      submissions = submissions.filter((sub) => {
        if (!sub?.submitted_at) return false;
        const t = DateTime.fromISO(sub.submitted_at);
        return t.isValid && t >= sTs && t < uTs;
      });

      for (const submission of submissions) {
        const submission_user_id = submission.user_id;

        // Ensure student exists even if not present in the current enrollments list (rare)
        // We already have name/score/status for most from enrollments; if missing, do a one-off lookup.
        let name = null;
        let currentScore = null;
        const enr = enrollments.find(e => e.user_id === submission_user_id);
        if (enr) {
          name = enr.user?.name || enr.user?.short_name || null;
          currentScore = (enr.grades && typeof enr.grades.current_score === 'number')
            ? enr.grades.current_score
            : null;
        } else {
          const userDetails = await canvasRequest(`courses/${courseId}/users/${submission_user_id}`);
          const student = userDetails?.data || {};
          name = student.name || null;
        }

        const dbStudentId = await ensureStudent(client, {
          userId: submission_user_id,
          name,
          currentScore,
          dbCourseId,
          // If not found in enrollments, default to active; otherwise keep authoritative status.
          status: enr ? (enr.enrollment_state || enr.state || 'active') : 'active',
        });

        // Upsert submission by canvas_submission_id
        await client.query(
          `INSERT INTO quiz_submissions (canvas_submission_id, quiz_id, user_id, submitted_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (canvas_submission_id) DO UPDATE
             SET quiz_id = EXCLUDED.quiz_id,
                 user_id = EXCLUDED.user_id,
                 submitted_at = GREATEST(quiz_submissions.submitted_at, EXCLUDED.submitted_at)`,
          [submission.id, dbQuizId, dbStudentId, submission.submitted_at]
        );

        // Get db submission id
        const { rows: subRows } = await client.query(
          `SELECT id FROM quiz_submissions WHERE canvas_submission_id = $1`,
          [submission.id]
        );
        if (!subRows.length) {
          console.warn('quiz_submissions row not found after upsert; skipping question_scores', submission.id);
          continue;
        }
        const dbSubmissionId = subRows[0].id;

        // Parse answers
        const history = submission.submission_history || [];
        const submissionData = history[0]?.submission_data;
        if (!Array.isArray(submissionData)) continue;

        const parsedAnswers = [];
        for (const resp of submissionData) {
          const qid = resp.question_id;
          const q = allQuestions.find((x) => x.id === qid);
          if (!q || q.question_type !== 'multiple_dropdowns_question') continue;

          const answerTexts = {};
          for (const key in resp) {
            if (key.startsWith('answer_id_for_')) {
              const blankId = key.replace('answer_id_for_', '');
              const answerId = resp[key];
              const matched = (q.answers || []).find(
                (opt) => opt.id === answerId && opt.blank_id === blankId
              );
              answerTexts[blankId] = matched ? matched.text : '[Unknown]';
            }
          }
          parsedAnswers.push({ questionId: qid, answers: answerTexts });
        }

        const userScores = extractQuizScoresByUser([
          { submissionId: dbSubmissionId, studentId: dbStudentId, answers: parsedAnswers },
        ]);

        // Batch insert question_scores
        const values = [];
        const params = [];
        let p = 1;
        for (const { submissionId, scores } of userScores) {
          for (const [code, score] of Object.entries(scores)) {
            const questionId = codeToQuestionId[code];
            if (!questionId) continue;
            params.push(submissionId, questionId, score);
            values.push(`($${p++}, $${p++}, $${p++})`);
          }
        }
        if (values.length) {
          await client.query(
            `INSERT INTO question_scores (submission_id, question_id, score)
             VALUES ${values.join(',')}
             ON CONFLICT DO NOTHING`,
            params
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    console.error('Error seeding quiz data:', err);
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seedQuiz };
