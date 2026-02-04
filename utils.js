const https = require('https');
const axiosBase = require('axios');
const axios = axiosBase;

const scaleMap = {
    'strongly disagree': 1,
    'disagree': 2,
    'slightly disagree': 3,
    'slightly agree': 4,
    'agree': 5,
    'strongly agree': 6,
};

const CANVAS_API_BASE = process.env.LTI_PLATFORM_URL
const CANVAS_TOKEN = process.env.CANVAS_TOKEN

const http = axiosBase.create({
    baseURL: `${CANVAS_API_BASE}/api/v1/`,
    timeout: 8000, // for each paginated call
    httpsAgent: new https.Agent({ keepAlive: true }),
    headers: {
        'Authorization': `Bearer ${CANVAS_TOKEN}`,
    },
    validateStatus: s => s >= 200 && s < 400,
});

// log w/o headers
function logRequest(method, url) {
    const full = /^https?:\/\//.test(url)
        ? url
        : `${http.defaults.baseURL.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
    console.log(`[Canvas API] ${method} ${full}`);
}

async function canvasRequest(endpointOrUrl, method = 'GET', paramsOrData = undefined) {
    const isAbs = /^https?:\/\//.test(endpointOrUrl);
    const url = isAbs ? endpointOrUrl : endpointOrUrl.replace(/^\//, ''); // prevent // after /api/v1

    logRequest(method, isAbs ? endpointOrUrl : `/${url}`);

    const cfg = { method, url };
    if (method === 'GET') {
        // GET must not send a body; use query params only
        if (paramsOrData) cfg.params = paramsOrData;
    } else if (paramsOrData) {
        cfg.data = paramsOrData;
    }
    return http.request(cfg);
}

async function getAllPages(url, config = {}) {
  let allData = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await axios.get(nextUrl, {
      ...config,
      headers: {
        ...config.headers,
        Authorization: `Bearer ${process.env.CANVAS_TOKEN}`
      }
    });

    allData = allData.concat(response.data);

    const linkHeader = response.headers.link;
    const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>; rel="next"/);
    nextUrl = nextMatch ? nextMatch[1] : null;
  }

  return allData;
}

async function getQuizzesByCourseId(courseId) {
    let allQuizzes = [];
    let url = `courses/${courseId}/quizzes`

    while (url) {
        const response = await canvasRequest(url);
        allQuizzes = allQuizzes.concat(response.data);

        // Parse pagination links from response headers
        const linkHeader = response.headers.link;
        const nextLinkMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        url = nextLinkMatch ? nextLinkMatch[1].replace('https://unlv.test.instructure.com/api/v1/', '') : null;
    }

    const dailyReflections = allQuizzes.filter(quiz =>
        quiz.title.startsWith('Reflection')
    );

    return dailyReflections;
}

async function getUsersByCourseId(courseId) { // get active students only - so cannot be used to identify dropped students
    let allUsers = [];
    let url = `courses/${courseId}/users?enrollment_type=student&include[]=enrollments&per_page=100`;
    
    while (url) {
        const response = await canvasRequest(url);
        allUsers = allUsers.concat(response.data);

        // Parse pagination links from response headers
        const linkHeader = response.headers.link;
        const nextLinkMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        url = nextLinkMatch ? nextLinkMatch[1].replace('https://unlv.test.instructure.com/api/v1/', '') : null;

    }

    return allUsers;
}

async function getAllPages(url, config = {}) {
  let allData = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await axios.get(nextUrl, {
      ...config,
      headers: {
        ...config.headers,
        Authorization: `Bearer ${process.env.CANVAS_TOKEN}`
      }
    });

    allData = allData.concat(response.data);

    const linkHeader = response.headers.link;
    const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>; rel="next"/);
    nextUrl = nextMatch ? nextMatch[1] : null;
  }

  return allData;
}

function extractQuizScoresByUser(submissions) {
    const reverseKeys = ['cult1', 'cult2', 'cult3', 'cult4', 'cult5', 'with2', 'with5'];

    const result = submissions.map(submission => {
        const userScores = {};
        submission.answers.forEach(questionAnswer => {
            const answerObj = questionAnswer.answers;

            Object.entries(answerObj).forEach(([blankId, text]) => {
                let score = scaleMap[text?.toLowerCase()]; 
                if (!score) return;

                if (reverseKeys.includes(blankId)) {
                    score = 7 - score;
                }

                userScores[blankId] = score;
            });
        });
        return {
            submissionId: submission.submissionId,
            studentId: submission.studentId,
            scores: userScores
        };
    });

    return result;
}

module.exports = {
    canvasRequest,
    getAllPages,
    getQuizzesByCourseId,
    getUsersByCourseId,
    extractQuizScoresByUser,
};