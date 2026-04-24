// seedQuiz.js
const db = require('./db'); // keep RDS here; use ./dbTimescale only for click
const { DateTime } = require('luxon');
const { sendAlertEmail } = require("./notify"); 
const {
  canvasRequest,
  getAllPages,
  getQuizzesByCourseId,
  extractQuizScoresByUser,
} = require('./utils');

const PT_ZONE = 'America/Los_Angeles';

function toPT(iso) {
  if (!iso) return 'n/a';
  const dt = DateTime.fromISO(iso, { zone: 'utc' });
  return dt.isValid
    ? dt.setZone(PT_ZONE).toFormat('yyyy-LL-dd HH:mm ZZZZ')
    : 'invalid';
}

const QUESTION_LIST = [ // streamlined for SP26
  { code: 'employ', prompt: "What is your employment status?", choiceType: "employment" },
  { code: 'numcourse', prompt: "How many courses are you enrolled in this semester?", choiceType: "enrollCourse" },
  { code: 'comit1', prompt: "Do you have ongoing family or caregiving responsibilities this semester?", choiceType: "boolean" },
  { code: 'comit2', prompt: "Are you involved in any extracurricular activities (e.g. athletics, clubs, student government)?", choiceType: "boolean" },
  { code: 'fin', prompt: "Does your financial situation feel manageable this semester?", choiceType: "boolean" },
  { code: 'with_v2', prompt: "I am considering withdrawing from this class.", choiceType: "boolean" },
  { code: 'supp', prompt: "I feel like I need extra help in this class.", choiceType: "boolean" },
  { code: 'con1', prompt: "I am confident in my ability to complete the work in this class.", choiceType: "scale" },  
  { code: 'con2', prompt: "I am certain I can learn the content taught in this class.", choiceType: "scale" },
  { code: 'con3', prompt: "I am good at learning the content covered in this class.", choiceType: "scale" },
  { code: 'sth1', prompt: "I manage my time effectively for this course.", choiceType: "scale" },
  { code: 'sth2', prompt: "I keep up with the readings and assignments for this course.", choiceType: "scale" },
  { code: 'sth3', prompt: "I balance the work in this class with my other commitments.", choiceType: "scale" },
  { code: 'abur1', prompt: "Sometimes I wish I could “run away” from this class.", choiceType: "scale" },
  { code: 'abur2', prompt: "I am worried about my future because of how I am performing in this class.", choiceType: "scale" },
  { code: 'abur3', prompt: "My relationships with family, relatives, and friends are suffering because this class is a challenge.", choiceType: "scale" },
  { code: 'mot1', prompt: "I do my work in this class because I enjoy it.", choiceType: "scale" },
  { code: 'mot2', prompt: "I do my work in this class because I want to learn new things.", choiceType: "scale" },
  { code: 'mot3', prompt: "In this class, I have been doing what really interests me.", choiceType: "scale" },
  { code: 'res1', prompt: "I have a hard time making it through stressful things in this class.", choiceType: "scale" },
  { code: 'res2', prompt: "It is difficult for me to recover when I get overwhelmed in this class.", choiceType: "scale" },
  { code: 'res3', prompt: "It takes me a long time to get over set-backs in this class.", choiceType: "scale" }
];

function constructCodeForQuestionCode(qCode) {
  // exact matches
  if (["employ","numcourse","fin","with_v2","supp"].includes(qCode)) return qCode;

  // prefix groups   
  if (qCode.startsWith("comit")) return "comit";
  if (qCode.startsWith("con")) return "con";
  if (qCode.startsWith("sth")) return "sth";
  if (qCode.startsWith("abur")) return "abur";
  if (qCode.startsWith("mot")) return "mot";
  if (qCode.startsWith("res")) return "res";

  return null;
}

const TERM_YEAR = 2026;
const TERM_SEMESTER = 'SP';

function resolveWindow(sinceISO, untilISO, now = DateTime.now().setZone(PT_ZONE)) {
  const today2 = now.startOf('day').plus({ hours: 2 });
  const anchor = (now < today2) ? today2.minus({ days: 1 }) : today2;
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

const extractCodesFromQuestionText = (questionText) => {
  // const matches = questionText.match(/\[([a-z]+\d+)\]/gi); // e.g., [se1]
  // return matches ? matches.map((m) => m.replace(/\[|\]/g, '')) : [];

  // updated on 011226 to handle code: employ, with_v2, etc.
  const matches = questionText.match(/\[([a-z_]+(?:\d+)?)\]/gi);
  return matches ? matches.map(m => m.slice(1, -1)) : [];

};

async function seedQuestionsOnce() {
  const client = await db.quizDb.connect();
  try {
    await client.query('BEGIN');
    for (const { code, prompt } of QUESTION_LIST) {

      const cCode = constructCodeForQuestionCode(code);
      if (!cCode) throw new Error(`No construct match for question code ${code}`);
      const { rows: cRows } = await client.query(
        `
        SELECT id
        FROM constructs
        WHERE code = $1
          AND year = $2
          AND semester = $3
          AND status = 'active'
        `,
        [cCode, TERM_YEAR, TERM_SEMESTER]
      );
      if (cRows.length === 0){
        throw new Error(`Construct not found for code ${cCode} (${TERM_SEMESTER}${TERM_YEAR})`);
      }
      const constructId = cRows[0].id;

      await client.query(
        `INSERT INTO questions (code, prompt, construct_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE 
         SET prompt = EXCLUDED.prompt,
             construct_id = EXCLUDED.construct_id
         `,
        [code, prompt, constructId]
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

/** Build a userId -> current_score map from enrollments */
async function buildScoreMap(courseId) {
  try {
    const enrollments = await getAllPages(
      `https://unlv.instructure.com/api/v1/courses/${courseId}/enrollments?type[]=StudentEnrollment`
    );
    const scoreMap = {};
    for (const enr of enrollments) {
      const uid = enr.user_id;
      const cs = enr.grades?.current_score;
      if (uid && typeof cs === 'number') scoreMap[uid] = cs;
    }
    return scoreMap;
  } catch (err) {
    console.error(`Failed to retrieve enrollments for course ${courseId}:`, err);
    return {};
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

async function seedMissingAssignments(client, courseId, studentIdByUserId) {
  let summaries = [];
  try {
    summaries = await getAllPages(
      `https://unlv.instructure.com/api/v1/courses/${courseId}/analytics/student_summaries`
    );
  } catch (err) {
    console.error(`Failed to retrieve student summaries for course ${courseId}:`, err);
    return
  }

  for (const summary of summaries) {
    const canvasUserId = summary.id;
    const missing = summary.tardiness_breakdown?.missing ?? 0; 

    const dbStudentId = studentIdByUserId[canvasUserId];
    if (!dbStudentId){
      console.warn(`Skipping missing student for user ${canvasUserId}; not in current course roster`);
      continue;
    }
    
    await client.query(
      `UPDATE students SET missing_assignments = $1 WHERE id = $2`,
      [missing, dbStudentId]
    );
  }
s
  console.log(`Updated missing assignments for ${summaries.length} students`);
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
      `INSERT INTO courses (canvas_course_id, name, is_demo, year, semester, status)
       VALUES ($1, $2, false, $3, $4, $5)
       ON CONFLICT (canvas_course_id) DO UPDATE 
       SET name = EXCLUDED.name,
           year = EXCLUDED.year,
           semester = EXCLUDED.semester,
           status = EXCLUDED.status
       RETURNING id`,
      [courseId, courseName, TERM_YEAR, TERM_SEMESTER, 'active']
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

    // await seedExternalScoresForRoster(client, enrollments, studentIdByUserId);
    await seedMissingAssignments(client, courseId, studentIdByUserId)

    // 4) Quizzes
    const unpublished = [];
    const quizzes = await getQuizzesByCourseId(courseId);
    for (const quiz of quizzes) {
      if (quiz.published === false) {
        unpublished.push({
          courseId,
          quizId: quiz.id,
          title: quiz.title,
          unlock_at: toPT(quiz.unlock_at),
          lock_at: toPT(quiz.lock_at),
          due_at: toPT(quiz.due_at),
        });
      }
      
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
      console.log(
        'Quiz:',
        quiz.title,
        'published=', quiz.published,
        'due=', toPT(quiz.due_at),
        'unlock=', toPT(quiz.unlock_at),
        'lock=', toPT(quiz.lock_at)
      );
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

    if (unpublished.length) {
      const lines = unpublished.map(x =>
        `- ${x.courseId},${x.title},unlock=${x.unlock_at},lock=${x.lock_at},due=${x.due_at}`
      ).join("\n");

      await sendAlertEmail({
        subject: `[iTOOLS] Unpublished quizzes detected (course ${courseId})`,
        text:
        `Found ${unpublished.length} unpublished quiz(es) while seeding.
        Course: ${courseId}
        ${lines}
        `
      })
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
