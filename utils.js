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

const SCORE_MAP_BY_TYPE = {
    scale: {
        'strongly disagree': 1, // "Disagree" - capitalization made this response fail to catch earlier
        'disagree': 2,
        'slightly disagree': 3,
        'slightly agree': 4,
        'agree': 5,
        'strongly agree': 6,
    },
    boolean: {
        'no': 1,
        'sometimes': 2,
        'yes': 3,
    },
    employment: {
        'not working': 1,
        'working part time': 2,
        'working full time': 3,
    },
    enrollCourse: {
        "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, 
        "6 or more": 6,
    },
};

const CODE_TYPE_MAP = {
    employ: "employment",
    numcourse: "enrollCourse",
    comit1: "boolean",
    comit2: "boolean",
    fin: "boolean",
    with_v2: "boolean",
    supp: "boolean",
    con1: "scale",
    con2: "scale",
    con3: "scale",
    sth1: "scale",
    sth2: "scale",
    sth3: "scale",
    abur1: "scale",
    abur2: "scale",
    abur3: "scale",
    mot1: "scale",
    mot2: "scale",
    mot3: "scale",
    res1: "scale",
    res2: "scale",
    res3: "scale",
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

function isAbsUrl(s) {
    return /^https?:\/\//.test(String(s));
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// optional: small jitter avoids thundering herd
function withJitter(ms, pct = 0.2) {
    const delta = ms * pct;
    return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * delta));
}

function getWaitMsFromHeaders(headers) {
    const retryAfter = headers?.['retry-after'];
    if (retryAfter && !Number.isNaN(Number(retryAfter))) {
        return Number(retryAfter) * 1000 + 250; // convert to ms
    }

    const reset = headers?.['x-rate-limit-reset'];
    if (reset && !Number.isNaN(Number(reset))) {
        const resetMs = Number(reset) * 1000;
        const nowMs = Date.now();
        if (resetMs > nowMs) {
            return resetMs - nowMs + 250; // add small buffer
        }
    }
    
    return null; // no info available
}

  

// log w/o headers
function logRequest(method, url) {
    const full = /^https?:\/\//.test(url)
        ? url
        : `${http.defaults.baseURL.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
    console.log(`[Canvas API] ${method} ${full}`);
}

const canvasRequest = async (endpoint, method = 'GET', data = {}, opts = {}) => {
    const { maxRetries = 8 } = opts;

    const isFullUrl = /^https?:\/\//.test(endpoint);
    const cleanEndpoint = String(endpoint).replace(/^\/+/, ''); // prevent // after /api/v1
    const url = isFullUrl ? endpoint : `${CANVAS_API_BASE}/api/v1/${cleanEndpoint}`;
    // console.log(`[Canvas API] ${method} ${url}`);
    let attempt = 0;

    while (true) {
        try {
            // console.log(`[Canvas API] ${method} ${url} (attempt ${attempt + 1})`);
            const config = {
                method,
                url,
                headers: { Authorization: `Bearer ${CANVAS_TOKEN}` },
            };

            if (method.toUpperCase() !== 'GET') config.data = data;
            
            return await axiosBase(config);
        } catch (err) {
            const status = err.response?.status;
            if (status === 429 && attempt < maxRetries) {
                const headerWait = getWaitMsFromHeaders(err.response?.headers || {});
                const backoffWait = 1000 * Math.pow(2, attempt); // exponential backoff
                const waitMs = headerWait ?? backoffWait;

                console.warn(
                    `[Canvas API] Rate limit hit. Retrying in ${waitMs} ms (attempt ${attempt + 1}/${maxRetries})`
                );
                await sleep(waitMs);
                attempt++;
                continue;
            }
            throw err;      
        }
    }

};

async function getAllPages(url, config = {}) {
  let allData = [];
  let nextUrl = url;

  while (nextUrl) {
    // const response = await axios.get(nextUrl, {
    //   ...config,
    //   headers: {
    //     ...config.headers,
    //     Authorization: `Bearer ${process.env.CANVAS_TOKEN}`
    //   }
    // });
    const res = await canvasRequest(nextUrl);

    allData = allData.concat(res.data);

    const linkHeader = res.headers.link;
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

function extractQuizScoresByUser(submissions) {
    const reverseKeys = ['res1', 'res2', 'res3'];

    const result = submissions.map(submission => {
        const userScores = {};
        submission.answers.forEach(questionAnswer => {
            const answerObj = questionAnswer.answers;

            Object.entries(answerObj).forEach(([blankId, rawText]) => {
                const text = (rawText || '').trim().toLowerCase();
                if (!text) return;

                const choiceType = CODE_TYPE_MAP[blankId] || 'scale';
                const map = SCORE_MAP_BY_TYPE[choiceType];
                if (!map) return;

                let score = map[text];
                if (typeof score != 'number') return;

                if (reverseKeys.includes(blankId) && choiceType === 'scale') {
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

async function getAnalyticsAssignmentsByUser(courseId, userId) {
    return getAllPages(`courses/${courseId}/analytics/users/${userId}/assignments`)
}

async function getMissingAssignmentsCount(courseId, userId) {
    
}

module.exports = {
    canvasRequest,
    getAllPages,
    getQuizzesByCourseId,
    getUsersByCourseId,
    extractQuizScoresByUser,
};