// seedQuiz.js
const db = require('./db'); // keep RDS here; use ./dbTimescale only for click
const { DateTime } = require('luxon');
const { sendAlertEmail } = require("./notify");
const {
  isQuizExamGroup,
  canvasRequest,
  getAllPages,
  getQuizzesByCourseId,
  extractQuizScoresByUser,
  parseTermName,
} = require('./utils');

const PT_ZONE = 'America/Los_Angeles';
const CANVAS_API_BASE = process.env.LTI_PLATFORM_URL;

function toPT(iso) {
  if (!iso) return 'n/a';
  const dt = DateTime.fromISO(iso, { zone: 'utc' });
  return dt.isValid
    ? dt.setZone(PT_ZONE).toFormat('yyyy-LL-dd HH:mm ZZZZ')
    : 'invalid';
}

const QUESTION_LIST = [ // streamlined for SP26
  { code: 'employ',   prompt: "What is your employment status?",                                                                                choiceType: "employment"  },
  { code: 'numcourse',prompt: "How many courses are you enrolled in this semester?",                                                            choiceType: "enrollCourse"},
  { code: 'comit1',   prompt: "Do you have ongoing family or caregiving responsibilities this semester?",                                       choiceType: "boolean"     },
  { code: 'comit2',   prompt: "Are you involved in any extracurricular activities (e.g. athletics, clubs, student government)?",                choiceType: "boolean"     },
  { code: 'fin',      prompt: "Does your financial situation feel manageable this semester?",                                                   choiceType: "boolean"     },
  { code: 'with_v2',  prompt: "I am considering withdrawing from this class.",                                                                  choiceType: "boolean"     },
  { code: 'supp',     prompt: "I feel like I need extra help in this class.",                                                                   choiceType: "boolean"     },
  { code: 'con1',     prompt: "I am confident in my ability to complete the work in this class.",                                               choiceType: "scale"       },
  { code: 'con2',     prompt: "I am certain I can learn the content taught in this class.",                                                     choiceType: "scale"       },
  { code: 'con3',     prompt: "I am good at learning the content covered in this class.",                                                       choiceType: "scale"       },
  { code: 'sth1',     prompt: "I manage my time effectively for this course.",                                                                  choiceType: "scale"       },
  { code: 'sth2',     prompt: "I keep up with the readings and assignments for this course.",                                                   choiceType: "scale"       },
  { code: 'sth3',     prompt: "I balance the work in this class with my other commitments.",                                                    choiceType: "scale"       },
  { code: 'abur1',    prompt: 'Sometimes I wish I could \u201crun away\u201d from this class.',                                                 choiceType: "scale"       },
  { code: 'abur2',    prompt: "I am worried about my future because of how I am performing in this class.",                                     choiceType: "scale"       },
  { code: 'abur3',    prompt: "My relationships with family, relatives, and friends are suffering because this class is a challenge.",          choiceType: "scale"       },
  { code: 'mot1',     prompt: "I do my work in this class because I enjoy it.",                                                                 choiceType: "scale"       },
  { code: 'mot2',     prompt: "I do my work in this class because I want to learn new things.",                                                 choiceType: "scale"       },
  { code: 'mot3',     prompt: "In this class, I have been doing what really interests me.",                                                     choiceType: "scale"       },
  { code: 'res1',     prompt: "I have a hard time making it through stressful things in this class.",                                           choiceType: "scale"       },
  { code: 'res2',     prompt: "It is difficult for me to recover when I get overwhelmed in this class.",                                        choiceType: "scale"       },
  { code: 'res3',     prompt: "It takes me a long time to get over set-backs in this class.",                                                   choiceType: "scale"       },
];

function constructCodeForQuestionCode(qCode) {
  if (["employ","numcourse","fin","with_v2","supp"].includes(qCode)) return qCode;
  if (qCode.startsWith("comit")) return "comit";
  if (qCode.startsWith("con"))   return "con";
  if (qCode.startsWith("sth"))   return "sth";
  if (qCode.startsWith("abur"))  return "abur";
  if (qCode.startsWith("mot"))   return "mot";
  if (qCode.startsWith("res"))   return "res";
  return null;
}

const TERM_YEAR = 2026;
const TERM_SEMESTER = 'FA';

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
    sinceISO:   parsedSince.toISO(),
    untilISO:   parsedUntil.toISO(),
    sinceLocal: parsedSince.toFormat('yyyy-LL-dd HH:mm ZZZZ'),
    untilLocal: parsedUntil.toFormat('yyyy-LL-dd HH:mm ZZZZ'),
  };
}

const MISSING_ASSIGNMENT_EXCLUDE = /\b(reflection|syllabus|not counted|final grades|extra credit|survey|not for points)\b/i;

function countsTowardMissing(assignment) {
  return assignment.points_possible > 0 && !MISSING_ASSIGNMENT_EXCLUDE.test(assignment.name);
}

async function seedQuestionsOnce() {
  const client = await db.quizDb.connect();
  try {
    await client.query('BEGIN');
    for (const { code, prompt } of QUESTION_LIST) {
      const cCode = constructCodeForQuestionCode(code);
      if (!cCode) throw new Error(`No construct match for question code ${code}`);
      const { rows: cRows } = await client.query(
        `SELECT id FROM constructs
         WHERE code = $1 AND year = $2 AND semester = $3 AND status = 'active'`,
        [cCode, TERM_YEAR, TERM_SEMESTER]
      );
      if (cRows.length === 0) {
        throw new Error(`Construct not found for code ${cCode} (${TERM_SEMESTER}${TERM_YEAR})`);
      }
      await client.query(
        `INSERT INTO questions (code, prompt, construct_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE
           SET prompt = EXCLUDED.prompt,
               construct_id = EXCLUDED.construct_id`,
        [code, prompt, cRows[0].id]
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
  // per_page=100 (Canvas max) — without it this defaults to 10/page, meaning
  // 80 sequential pages instead of 8 at ~800 students.
  const url =
    `${CANVAS_API_BASE}/api/v1/courses/${courseId}/enrollments` +
    `?type[]=StudentEnrollment&state[]=active&state[]=inactive&state[]=completed&state[]=invited&include[]=user&per_page=100`;
  return getAllPages(url);
}

/** Upsert a student and link to course; return db student id */
async function ensureStudent(client, { userId, name, dbCourseId, status = 'active', integrationId = null, sectionNumber }) {
  const upsert = await client.query(
     `INSERT INTO students (canvas_user_id, name, integration_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (canvas_user_id) DO UPDATE
        SET name = EXCLUDED.name,
            integration_id = COALESCE(EXCLUDED.integration_id, students.integration_id)
      RETURNING id`,
      [userId, name || '', integrationId || null]
  );
  console.log(`ensureStudent: userId=${userId} -> dbStudentId=${upsert.rows[0].id} updated`);

  const dbStudentId = upsert.rows[0].id;

  await client.query(
    `INSERT INTO student_courses (student_id, course_id, status, section_number)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (student_id, course_id) DO UPDATE
       SET status = EXCLUDED.status,
       section_number = COALESCE(EXCLUDED.section_number, student_courses.section_number)`,
    [dbStudentId, dbCourseId, status || 'active', sectionNumber || null]
  );

  return dbStudentId;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Bulk upsert an entire roster (students + student_courses) in a small number
 * of multi-row round trips, instead of ensureStudent()'s 2 sequential round
 * trips PER STUDENT. At ~800 students, ensureStudent() in a loop means 1,600
 * sequential awaited queries; this collapses that to ~4-6 for chunks of 500.
 * Returns { canvasUserId: dbStudentId }.
 */
async function ensureStudentsBulk(client, students, dbCourseId, chunkSize = 500) {
  const studentIdByUserId = {};

  for (const chunk of chunkArray(students, chunkSize)) {
    const sParams = [];
    const sValues = [];
    let p = 1;
    for (const s of chunk) {
      sValues.push(`($${p++}, $${p++}, $${p++})`);
      sParams.push(s.userId, s.name || '', s.integrationId || null);
    }
    const { rows: studentRows } = await client.query(
      `INSERT INTO students (canvas_user_id, name, integration_id)
       VALUES ${sValues.join(',')}
       ON CONFLICT (canvas_user_id) DO UPDATE
         SET name = EXCLUDED.name,
             integration_id = COALESCE(EXCLUDED.integration_id, students.integration_id)
       RETURNING id, canvas_user_id`,
      sParams
    );
    for (const row of studentRows) studentIdByUserId[row.canvas_user_id] = row.id;

    const scParams = [];
    const scValues = [];
    p = 1;
    for (const s of chunk) {
      const dbStudentId = studentIdByUserId[s.userId];
      scValues.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      scParams.push(dbStudentId, dbCourseId, s.status || 'active', s.sectionNumber || null);
    }
    await client.query(
      `INSERT INTO student_courses (student_id, course_id, status, section_number)
       VALUES ${scValues.join(',')}
       ON CONFLICT (student_id, course_id) DO UPDATE
         SET status = EXCLUDED.status,
             section_number = COALESCE(EXCLUDED.section_number, student_courses.section_number)`,
      scParams
    );
  }

  return studentIdByUserId;
}

/** Bulk insert student_score_snapshots rows — one round trip per chunk instead of per student. */
async function insertScoreSnapshotsBulk(client, snapshots, chunkSize = 500) {
  for (const chunk of chunkArray(snapshots, chunkSize)) {
    const params = [];
    const values = [];
    let p = 1;
    for (const snap of chunk) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NOW())`);
      params.push(
        snap.dbStudentId,
        snap.dbCourseId,
        snap.currentScore ?? null,
        snap.quizScore ?? null,
        snap.missing ?? null,
      );
    }
    await client.query(
      `INSERT INTO student_score_snapshots
         (student_id, course_id, current_score, quiz_score, missing_assignments, recorded_at)
       VALUES ${values.join(',')}`,
      params
    );
  }
}

/** Build section map: canvas_user_id -> section number string */
async function buildSectionMap(courseId) {
  let sections = [];
  try {
    // per_page=100 — same reasoning as getCourseEnrollments.
    sections = await getAllPages(
      `${CANVAS_API_BASE}/api/v1/courses/${courseId}/sections?include[]=students&per_page=100`
    );
  } catch (err) {
    console.error(`Failed to retrieve sections for course ${courseId}:`, err.message);
    return {};
  }
  const userToSection = {};
  for (const section of sections) {
    const sectionNumber = section.sis_section_id?.match(/SEC(\d+)/)?.[1] || null;
    for (const student of (section.students || [])) {
      userToSection[student.id] = sectionNumber;
    }
  }
  return userToSection;
}

/** Seed missing assignments count for lab courses (called from seedLabData only) */
async function seedMissingAssignments(client, courseId, dbCourseId, studentIdByUserId) {
  let summaries = [];
  try {
    summaries = await getAllPages(
      `${CANVAS_API_BASE}/api/v1/courses/${courseId}/analytics/student_summaries`
    );
  } catch (err) {
    console.error(`Failed to retrieve student summaries for course ${courseId}:`, err.message);
    return;
  }

  for (const summary of summaries) {
    const canvasUserId = summary.id;
    const missing = summary.tardiness_breakdown?.missing ?? 0;

    const dbStudentId = studentIdByUserId[canvasUserId];
    if (!dbStudentId) {
      console.warn(`Skipping missing assignments for user ${canvasUserId}; not in current course roster`);
      continue;
    }

    await client.query(
      `INSERT INTO student_score_snapshots (student_id, course_id, missing_assignments, recorded_at)
       VALUES ($1, $2, $3, NOW())`,
      [dbStudentId, dbCourseId, missing]
    );
  }

  console.log(`Updated missing assignments for ${summaries.length} students in course ${courseId}`);
}

async function seedLabData(client, lectureDbCourseId) {
  const { rows } = await client.query(
    `SELECT id, canvas_course_id FROM courses
     WHERE parent_course_id = $1 AND course_type = 'lab'`,
    [lectureDbCourseId]
  );

  if (!rows.length) return;

  for (const lab of rows) {
    const labEnrollments = await getCourseEnrollments(lab.canvas_course_id);
    const labStudentIdByUserId = {};

    for (const enr of labEnrollments) {
      const uid = enr.user_id;
      const currentScore = (enr.grades && typeof enr.grades.current_score === 'number')
        ? enr.grades.current_score : null;
      if (!uid || typeof currentScore !== 'number') continue;

      const { rows: sRows } = await client.query(
        `SELECT id FROM students WHERE canvas_user_id = $1`, [uid]
      );
      if (!sRows.length) {
        console.warn(`No student found for user ${uid} (lab score ${currentScore} not linked)`);
        continue;
      }

      labStudentIdByUserId[uid] = sRows[0].id;

      await client.query(
        `INSERT INTO student_score_snapshots (student_id, course_id, current_score, recorded_at)
         VALUES ($1, $2, $3, NOW())`,
        [sRows[0].id, lab.id, currentScore]
      );
    }

    await seedMissingAssignments(client, lab.canvas_course_id, lab.id, labStudentIdByUserId);
  }
}
// 
// 
// 
//
// 
// 

/** Seed ONE course in a time window */
async function seedQuiz(courseId, sinceISO, untilISO) {
  const { sinceISO: sISO, untilISO: uISO, sinceLocal, untilLocal } = resolveWindow(sinceISO, untilISO);

  // 1) Ensure questions exist and get code->id map
  const codeToQuestionId = await seedQuestionsOnce();

  const client = await db.quizDb.connect();
  try {
    await client.query('BEGIN');
    console.log('----- Seeding quiz data for course:', courseId);
    console.log(`Time window PT:   [${sinceLocal} -> ${untilLocal}]`);
    console.log(`Time window ISO:  [${sISO} -> ${uISO}]`);

    // Step-timing: logs how long each major step took, so a CloudWatch log
    // shows exactly which step a run is in (or stuck in) instead of just a
    // silent gap followed by a timeout kill.
    let __stepStart = Date.now();
    const step = (label) => {
      const now = Date.now();
      console.log(`[step] ${label}: ${now - __stepStart}ms (course ${courseId})`);
      __stepStart = now;
    };

    // 2) Upsert course — include[]=term to resolve actual year/semester per
    // course instead of writing the hardcoded TERM_YEAR/TERM_SEMESTER for
    // every course regardless of what term it's actually in.
    const courseDetails = await canvasRequest(`courses/${courseId}?include[]=term`);
    step('canvasRequest courses/:id?include[]=term');
    const courseName = courseDetails?.data?.name || `Course ${courseId}`;
    const termName = courseDetails?.data?.term?.name || null;
    const parsedTerm = parseTermName(termName);
    const courseYear = parsedTerm.year ?? TERM_YEAR;
    const courseSemester = parsedTerm.semester ?? TERM_SEMESTER;
    if (parsedTerm.year === null || parsedTerm.semester === null) {
      console.warn(
        `Course ${courseId}: falling back to default term (${courseSemester}${courseYear}) — Canvas term name was "${termName}"`
      );
    }
    const courseUpsert = await client.query(
      `INSERT INTO courses (canvas_course_id, name, is_demo, year, semester, status)
       VALUES ($1, $2, false, $3, $4, $5)
       ON CONFLICT (canvas_course_id) DO UPDATE
         SET name = EXCLUDED.name,
             year = EXCLUDED.year,
             semester = EXCLUDED.semester,
             status = EXCLUDED.status
       RETURNING id`,
      [courseId, courseName, courseYear, courseSemester, 'active']
    );
    const dbCourseId = courseUpsert.rows[0].id;
    step('course upsert (DB)');

    // 3) Roster from enrollments (authoritative for status + grade + user)
    const enrollments = await getCourseEnrollments(courseId);
    step(`getCourseEnrollments (${enrollments.length} rows)`);
    const sectionMap = await buildSectionMap(courseId);
    step('buildSectionMap');

    const statusCounts = enrollments.reduce((acc, e) => {
      const s = e.enrollment_state || e.state || 'unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});
    console.log('Enrollment status counts:', statusCounts);

    // 3b) Build quiz/exam assignment ID set from assignment names
    const allAssignments = await getAllPages(
      `${CANVAS_API_BASE}/api/v1/courses/${courseId}/assignments?per_page=100`
    );
    step(`allAssignments fetch (${allAssignments.length} assignments)`);
    const quizExamAssignmentIds = new Set(
      allAssignments
        .filter(a => a.points_possible > 0 && isQuizExamGroup(a.name))
        .map(a => a.id)
    );
    console.log(`Found ${quizExamAssignmentIds.size} quiz/exam assignments for course ${courseId}`);

    // 3c) Fetch missing assignment counts once for all students
    let missingByUserId = {};
    try {

      const countedAssignmentIds = allAssignments
        .filter(countsTowardMissing)
        .map(a => a.id);

      if (countedAssignmentIds.length) {
        const idParams = countedAssignmentIds.map(id => `assignment_ids[]=${id}`).join('&');
        const submissions = await getAllPages(
          `${CANVAS_API_BASE}/api/v1/courses/${courseId}/students/submissions` +
          `?student_ids[]=all&${idParams}&per_page=100`
        );

        for (const sub of submissions) {
          if (sub.missing) {
            missingByUserId[sub.user_id] = (missingByUserId[sub.user_id] || 0) + 1;
          } else {
            missingByUserId[sub.user_id] = missingByUserId[sub.user_id] || 0;
          }
        }
      }
      console.log(`Computed missing assignment counts for ${Object.keys(missingByUserId).length} students`);
    } catch (err) {
      console.error(`Failed to compute missing assignments for course ${courseId}:`, err.message);
    }
    step('missingByUserId bulk computation');

    // 3d) Fetch quiz/exam scores ONCE for all students — replaces the
    // per-student `analytics/users/{uid}/assignments` call that used to run
    // inside the roster loop below. That call was measured at ~8s each in
    // debugging; at 800 students that's ~6,400s sequential, well past any
    // Lambda timeout. This computes the same thing from one bulk call using
    // the same students/submissions endpoint as 3c above, joined against the
    // already-fetched allAssignments for points_possible.
    let quizScoreByUserId = {};
    try {
      if (quizExamAssignmentIds.size) {
        const pointsByAssignmentId = new Map(allAssignments.map(a => [a.id, a.points_possible]));
        const idParams = [...quizExamAssignmentIds].map(id => `assignment_ids[]=${id}`).join('&');
        const quizSubmissions = await getAllPages(
          `${CANVAS_API_BASE}/api/v1/courses/${courseId}/students/submissions` +
          `?student_ids[]=all&${idParams}&per_page=100`
        );

        const earnedByUser = {};
        const possibleByUser = {};
        for (const sub of quizSubmissions) {
          if (sub.excused) continue;
          if (!sub.posted_at) continue;
          if (sub.score == null) continue;
          const possible = pointsByAssignmentId.get(sub.assignment_id);
          if (typeof possible !== 'number' || possible <= 0) continue;

          earnedByUser[sub.user_id] = (earnedByUser[sub.user_id] || 0) + sub.score;
          possibleByUser[sub.user_id] = (possibleByUser[sub.user_id] || 0) + possible;
        }

        for (const uid of Object.keys(possibleByUser)) {
          const earned = earnedByUser[uid] || 0;
          const possible = possibleByUser[uid];
          quizScoreByUserId[uid] = possible > 0
            ? Math.round((earned / possible) * 100 * 100) / 100
            : null;
        }
      }
      console.log(`Computed quiz/exam scores for ${Object.keys(quizScoreByUserId).length} students`);
    } catch (err) {
      console.error(`Failed to compute quiz/exam scores for course ${courseId}:`, err.message);
    }
    step('quizScoreByUserId bulk computation');

    // 4) Process each enrolled student — collect first, then bulk-write.
    // Previously: ensureStudent() (2 round trips) + 1 analytics Canvas call
    // + 1 snapshot INSERT, all sequential, PER STUDENT. At 800 students that
    // was ~1,600 DB round trips plus ~6,400s of Canvas calls. Now: 0 Canvas
    // calls here (quizScoreByUserId/missingByUserId already computed above
    // in bulk), and DB writes batched into a handful of multi-row queries.
    //
    // IMPORTANT: Canvas's Enrollments API returns one row PER ENROLLMENT,
    // not per student — a student can appear more than once (cross-listed
    // sections, or overlapping active/inactive/completed enrollment
    // records, since getCourseEnrollments requests all of those states).
    // The old sequential ensureStudent() calls tolerated duplicate
    // canvas_user_ids fine (each was its own SQL statement). The bulk
    // multi-row upsert cannot — Postgres rejects an ON CONFLICT DO UPDATE
    // that would touch the same conflict-target row twice in one
    // statement ("ON CONFLICT DO UPDATE command cannot affect row a
    // second time"). Dedupe by user_id first, keeping the LAST enrollment
    // record seen per student, which reproduces the old sequential
    // "last one processed wins" precedence.
    const rosterRowsByUserId = new Map();
    for (const enr of enrollments) {
      const uid = enr.user_id;
      if (!uid) continue;

      const integrationId = enr.user?.integration_id || null;
      const name = enr.user?.name || enr.user?.short_name || '';
      const status = enr.enrollment_state || enr.state || 'active';
      const currentScore = (
        enr.grades &&
        typeof enr.grades.current_score === 'number' &&
        enr.enrollment_state === 'active'
      ) ? enr.grades.current_score : null;
      const sectionNumber = sectionMap[uid] || null;
      const quizScore = quizScoreByUserId[uid] ?? null;
      const missing = missingByUserId[uid] ?? null;

      rosterRowsByUserId.set(uid, { userId: uid, name, status, integrationId, sectionNumber, currentScore, quizScore, missing });
    }
    const rosterRows = [...rosterRowsByUserId.values()];

    const studentIdByUserId = await ensureStudentsBulk(client, rosterRows, dbCourseId);

    await insertScoreSnapshotsBulk(
      client,
      rosterRows
        .filter((r) => typeof r.currentScore === 'number' || r.quizScore !== null || r.missing !== null)
        .map((r) => ({
          dbStudentId: studentIdByUserId[r.userId],
          dbCourseId,
          currentScore: r.currentScore,
          quizScore: r.quizScore,
          missing: r.missing,
        }))
    );
    step(`roster bulk upsert + snapshots (${rosterRows.length} students)`);

    // Lab courses: current_score + missing handled separately (different course shell)
    await seedLabData(client, dbCourseId);
    step('seedLabData');

    // 5) Reflection survey quizzes
    const unpublished = [];
    const quizzes = await getQuizzesByCourseId(courseId);
    step(`getQuizzesByCourseId (${quizzes.length} reflection quizzes)`);

    // 5a) Upsert every quiz row + fetch its questions first (cheap — DB
    // writes and small per-quiz question-definition fetches, NOT the
    // submissions themselves). Build lookup maps keyed by assignment_id so
    // the bulk submissions fetch below can be done ONCE across every quiz.
    const dbQuizIdByAssignmentId = {};
    const allQuestionsByAssignmentId = {};
    for (const quiz of quizzes) {
      if (quiz.published === false) {
        unpublished.push({
          courseId,
          quizId: quiz.id,
          title: quiz.title,
          unlock_at: toPT(quiz.unlock_at),
          lock_at:   toPT(quiz.lock_at),
          due_at:    toPT(quiz.due_at),
        });
      }

      const quizUpsert = await client.query(
        `INSERT INTO quizzes (canvas_quiz_id, assignment_id, course_id, title, due_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (canvas_quiz_id) DO UPDATE SET
           assignment_id = EXCLUDED.assignment_id,
           title         = EXCLUDED.title,
           due_at        = EXCLUDED.due_at
         RETURNING id`,
        [quiz.id, quiz.assignment_id, dbCourseId, quiz.title, quiz.due_at]
      );
      dbQuizIdByAssignmentId[quiz.assignment_id] = quizUpsert.rows[0].id;
      console.log(
        'Quiz:', quiz.title,
        'published=', quiz.published,
        'due=', toPT(quiz.due_at),
        'unlock=', toPT(quiz.unlock_at),
        'lock=', toPT(quiz.lock_at)
      );

      // Fetch quiz questions for answer-id -> text mapping
      const questionRes = await canvasRequest(`courses/${courseId}/quizzes/${quiz.id}/questions`);
      allQuestionsByAssignmentId[quiz.assignment_id] = questionRes?.data || [];
    }
    step(`quiz upserts + questions fetch (${quizzes.length} quizzes)`);

    // 5b) ONE bulk submissions fetch across ALL reflection quizzes, instead
    // of one call PER quiz. Two problems this fixes:
    //   1. The single-assignment submissions endpoint used previously has NO
    //      date-filter parameter at all (confirmed against Canvas's own
    //      controller source) — every run pulled the ENTIRE semester's
    //      submission_history for every past quiz, then threw almost all of
    //      it away in a JS filter. That gets worse every week as more
    //      reflection quizzes accumulate.
    //   2. It ran sequentially, one quiz at a time.
    // The bulk multi-assignment endpoint (same one already used for
    // missingByUserId/quizScoreByUserId above) DOES support a real
    // server-side `submitted_since` filter, confirmed against Canvas's
    // actual controller source (submissions_api_controller.rb, `for_students`
    // action) — and supports include[]=submission_history too.
    // Canvas requires this as a UTC "Z" timestamp, not the offset-form ISO
    // string resolveWindow produces, so convert before sending.
    const reflectionAssignmentIds = quizzes.map((q) => q.assignment_id).filter(Boolean);
    let allReflectionSubmissions = [];
    if (reflectionAssignmentIds.length) {
      const idParams = reflectionAssignmentIds.map((id) => `assignment_ids[]=${id}`).join('&');
      const submittedSinceUTC = DateTime.fromISO(sISO).toUTC().toISO();
      try {
        allReflectionSubmissions = await getAllPages(
          `${CANVAS_API_BASE}/api/v1/courses/${courseId}/students/submissions` +
          `?student_ids[]=all&${idParams}&include[]=submission_history` +
          `&submitted_since=${encodeURIComponent(submittedSinceUTC)}&per_page=100`
        );
      } catch (err) {
        console.error(`Failed to retrieve reflection submissions for course ${courseId}:`, err.message);
      }
    }
    step(`reflection submissions bulk fetch (${allReflectionSubmissions.length} rows across ${reflectionAssignmentIds.length} quizzes)`);

    // submitted_since is a lower bound only (no upper-bound param exists on
    // this endpoint) — keep the JS window filter as the source of truth for
    // the exact [sISO, uISO) window; the server-side filter above is purely
    // a payload-size optimization, not a correctness dependency.
    const sTs = DateTime.fromISO(sISO);
    const uTs = DateTime.fromISO(uISO);
    const windowedSubmissions = allReflectionSubmissions.filter((sub) => {
      if (!sub?.submitted_at) return false;
      const t = DateTime.fromISO(sub.submitted_at);
      return t.isValid && t >= sTs && t < uTs;
    });

    // Resolve students for these submissions in bulk, ONCE across every
    // quiz. Almost every submitter is already in studentIdByUserId from the
    // roster upsert above — only students NOT in current enrollments (rare)
    // need a one-off lookup + ensureStudent() call.
    const submitterIds = [...new Set(windowedSubmissions.map((s) => s.user_id).filter(Boolean))];
    const unresolvedIds = submitterIds.filter((uid) => !(uid in studentIdByUserId));
    for (const uid of unresolvedIds) {
      const enr = enrollments.find(e => e.user_id === uid);
      let name = null;
      if (enr) {
        name = enr.user?.name || enr.user?.short_name || null;
      } else {
        const userDetails = await canvasRequest(`courses/${courseId}/users/${uid}`);
        const student = userDetails?.data || {};
        name = student.name || null;
      }
      const dbStudentId = await ensureStudent(client, {
        userId: uid,
        name,
        dbCourseId,
        status: enr ? (enr.enrollment_state || enr.state || 'active') : 'active',
      });
      studentIdByUserId[uid] = dbStudentId;
    }
    step(`resolve unresolved submitters (${unresolvedIds.length})`);

    // Bulk upsert quiz_submissions across ALL quizzes at once, chunked,
    // RETURNING id in the same round trip (no separate SELECT needed).
    const submissionIdByCanvasId = {};
    for (const chunk of chunkArray(windowedSubmissions, 500)) {
      const values = [];
      const params = [];
      let p = 1;
      for (const sub of chunk) {
        const dbStudentId = studentIdByUserId[sub.user_id];
        const dbQuizId = dbQuizIdByAssignmentId[sub.assignment_id];
        if (!dbStudentId || !dbQuizId) continue;
        values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(sub.id, dbQuizId, dbStudentId, sub.submitted_at);
      }
      if (!values.length) continue;
      const { rows } = await client.query(
        `INSERT INTO quiz_submissions (canvas_submission_id, quiz_id, user_id, submitted_at)
         VALUES ${values.join(',')}
         ON CONFLICT (canvas_submission_id) DO UPDATE
           SET quiz_id      = EXCLUDED.quiz_id,
               user_id      = EXCLUDED.user_id,
               submitted_at = GREATEST(quiz_submissions.submitted_at, EXCLUDED.submitted_at)
         RETURNING id, canvas_submission_id`,
        params
      );
      for (const row of rows) submissionIdByCanvasId[row.canvas_submission_id] = row.id;
    }
    step(`quiz_submissions bulk upsert (${windowedSubmissions.length} submissions)`);

    // Parse answers + compute scores in memory (CPU only, no round trips),
    // collecting every question_scores row across ALL submissions for ALL
    // quizzes, then write them in a few chunked bulk inserts at the end.
    const allScoreRows = [];
    for (const submission of windowedSubmissions) {
      const dbSubmissionId = submissionIdByCanvasId[submission.id];
      if (!dbSubmissionId) {
        console.warn('quiz_submissions row not found after bulk upsert; skipping question_scores', submission.id);
        continue;
      }

      const allQuestions = allQuestionsByAssignmentId[submission.assignment_id] || [];

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
            const blankId  = key.replace('answer_id_for_', '');
            const answerId = resp[key];
            const matched  = (q.answers || []).find(
              (opt) => opt.id === answerId && opt.blank_id === blankId
            );
            answerTexts[blankId] = matched ? matched.text : '[Unknown]';
          }
        }
        parsedAnswers.push({ questionId: qid, answers: answerTexts });
      }

      const userScores = extractQuizScoresByUser([
        { submissionId: dbSubmissionId, studentId: studentIdByUserId[submission.user_id], answers: parsedAnswers },
      ]);

      for (const { submissionId, scores } of userScores) {
        for (const [code, score] of Object.entries(scores)) {
          const questionId = codeToQuestionId[code];
          if (!questionId) continue;
          allScoreRows.push({ submissionId, questionId, score });
        }
      }
    }
    step(`parse answers + compute scores (${allScoreRows.length} score rows)`);

    for (const chunk of chunkArray(allScoreRows, 1000)) {
      const values = [];
      const params = [];
      let p = 1;
      for (const row of chunk) {
        values.push(`($${p++}, $${p++}, $${p++})`);
        params.push(row.submissionId, row.questionId, row.score);
      }
      await client.query(
        `INSERT INTO question_scores (submission_id, question_id, score)
         VALUES ${values.join(',')}
         ON CONFLICT DO NOTHING`,
        params
      );
    }
    step('question_scores bulk insert');

    if (unpublished.length) {
      const lines = unpublished.map(x =>
        `- ${x.courseId},${x.title},unlock=${x.unlock_at},lock=${x.lock_at},due=${x.due_at}`
      ).join('\n');
      await sendAlertEmail({
        subject: `[iTOOLS] Unpublished quizzes detected (course ${courseId})`,
        text: `Found ${unpublished.length} unpublished quiz(es) while seeding.\nCourse: ${courseId}\n${lines}`,
      });
    }
    step('sendAlertEmail (if any unpublished)');

    await client.query('COMMIT');
    step('COMMIT');
  } catch (err) {
    console.error('Error seeding quiz data:', err);
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seedQuiz };