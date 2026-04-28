// index.js
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { seedQuiz } = require("./SeedQuiz");

const client = new LambdaClient({ region: "us-west-2" });
const FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;

exports.handler = async (event = {}) => {
  const { courses, courseId, sinceISO, untilISO, worker, termYear, termSemester } = event;

  // Worker
  if (worker || (courseId && !Array.isArray(courses))) {
    if (!courseId) return { statusCode: 400, body: "courseId required" };
    console.log("Worker starting for course:", courseId, { sinceISO, untilISO });
    await seedQuiz(courseId, sinceISO, untilISO, termYear, termSemester);   // ⬅️ change here
    return { statusCode: 200, body: `Completed course ${courseId}` };
  }

  // Dispatcher
  const list = Array.isArray(courses) ? courses : (courseId ? [courseId] : []);
  if (!list.length) return { statusCode: 400, body: "Provide courseId or courses[]" };

  const MAX_CONCURRENCY = 4;
  const queue = [...list];
  const runners = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async function run() {
    for (;;) {
      const c = queue.shift();
      if (!c) break;
      await client.send(new InvokeCommand({
        FunctionName: FUNCTION_NAME,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({
          worker: true,
          courseId: c,
          sinceISO,
          untilISO,
          termYear,
          termSemester
        }))
      }));
    }
  });

  await Promise.all(runners);
  return { statusCode: 202, body: `Dispatched ${list.length} course runs` };
};
