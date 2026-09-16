const https = require('https');
const axiosBase = require('axios');
const { parse } = require('path');
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

// const QUIZ_EXAM_INCLUDE = /\b(exam|quiz|quizes|test|midterm)\b/i;
// const QUIZ_EXAM_EXCLUDE = /\b(reflection|syllabus|not counted|final grades)\b/i;

// function isQuizExamGroup(name) {
//     const n = name.trim();
//     return QUIZ_EXAM_INCLUDE.test(n) && !QUIZ_EXAM_EXCLUDE.test(n);
// }

/* ---- Revised quiz/exam group detection logic ---- */
// Layer 1: Base classification — does the name contain quiz/exam-type language?
const QUIZ_EXAM_INCLUDE = /\b(exam|quiz|quizzes|test|midterm|final exam)\b/i;

// Layer 2: Modifiers that indicate the item is NOT actually a graded assessment,
// even though it matched Layer 1 (e.g. practice quizzes, ungraded reflections).
const NON_GRADED_MODIFIERS = /\b(practice|sample|ungraded|ungraded quiz|ptactice|not counted|no credit)\b/i;

// Layer 2: Modifiers that indicate the item should be excluded outright,
// regardless of Layer 1 — e.g. administrative groups that aren't assessments.
const HARD_EXCLUDE = /\b(reflection|final grades)\b/i;

function isQuizExamGroup(name) {
    const n = name.trim();

    // Layer 1: must look like a quiz/exam to even be considered
    if (!QUIZ_EXAM_INCLUDE.test(n)) {
        return false;
    }

    // Layer 2a: hard excludes always win, even over a Layer 1 match
    if (HARD_EXCLUDE.test(n)) {
        return false;
    }

    // Layer 2b: modifiers that suggest it's not a "real" graded assessment
    if (NON_GRADED_MODIFIERS.test(n)) {
        return false;
    }

    return true;
}

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

const CANVAS_REQUEST_TIMEOUT_MS = 20000; // fail loudly after 20s instead of hanging silently for the rest of the Lambda's budget

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
                timeout: CANVAS_REQUEST_TIMEOUT_MS,
            };

            if (method.toUpperCase() !== 'GET') config.data = data;
            
            return await axiosBase(config);
        } catch (err) {
            const status = err.response?.status;
            const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');

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

            if (isTimeout && attempt < maxRetries) {
                const waitMs = 1000 * Math.pow(2, attempt);
                console.warn(
                    `[Canvas API] Request TIMED OUT after ${CANVAS_REQUEST_TIMEOUT_MS}ms: ${method} ${url} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`
                );
                await sleep(waitMs);
                attempt++;
                continue;
            }

            if (isTimeout) {
                console.error(`[Canvas API] Request TIMED OUT after ${CANVAS_REQUEST_TIMEOUT_MS}ms and exhausted retries: ${method} ${url}`);
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
    let url = `courses/${courseId}/quizzes?per_page=100`; // Fetch quizzes with a page size of 100 to speed up the sequence

    while (url) {
        const response = await canvasRequest(url);
        allQuizzes = allQuizzes.concat(response.data);

        // Parse pagination links from response headers
        const linkHeader = response.headers.link;
        const nextLinkMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        url = nextLinkMatch ? nextLinkMatch[1].replace('{CANVAS_API_BASE}/api/v1/', '') : null;
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
        url = nextLinkMatch ? nextLinkMatch[1].replace('{CANVAS_API_BASE}/api/v1/', '') : null;

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

/**
 * Parse a Canvas enrollment term name into { year, semester }.
 *
 * Handles the term-name shapes Canvas/SIS commonly produce:
 *   "Spring 2026", "2026 Spring", "SP 2026", "2026 SP",
 *   "SP26", "2026SP", "26-SP", "Fall 2025", "FA25",
 *   "Summer 2026", "SU26", "2026 Sprg", "2026 Sumr", "Summer III 2026"
 *
 * semester is one of 'SP' | 'FA' | 'SU'. Either field can come back null
 * if it can't be confidently determined — callers should fall back to a
 * known-good default rather than write a guess, and a warning is logged
 * so unrecognized term-name formats are visible in the logs instead of
 * silently mis-tagging a course.
 */
function parseTermName(termName) {
    if (!termName || typeof termName !== 'string') {
        return { year: null, semester: null };
    }
 
    const text = termName.trim();
    const lower = text.toLowerCase();
 
    // --- Year: prefer a clean 4-digit year; fall back to a 2-digit year
    // glued to a season code (e.g. "SP26", "26-SP"). ---
    let year = null;
    const y4 = text.match(/(?<!\d)(20\d{2})/);
    if (y4) {
        year = parseInt(y4[1], 10);
    } else {
        const y2 = lower.match(/(?:sp|fa|su)\s*-?\s*(\d{2})\b/) || lower.match(/\b(\d{2})\s*-?\s*(?:sp|fa|su)\b/);
        if (y2) year = 2000 + parseInt(y2[1], 10);
    }
 
    // --- Semester: check full words/abbreviations first (unambiguous), then
    // fall back to bare 2-letter codes only when NOT adjacent to other letters
    // (so "SP26" matches but "Special" or "Fall" itself doesn't double-match
    // through the short-code path). ---
    let semester = null;
    if (/spring|sprg/.test(lower)) {
        semester = 'SP';
    } else if (/fall|autumn/.test(lower)) {
        semester = 'FA';
    } else if (/summer|sumr/.test(lower)) {
        semester = 'SU';
    } else if (/(?<![a-z])sp(?![a-z])/i.test(text)) {
        semester = 'SP';
    } else if (/(?<![a-z])fa(?![a-z])/i.test(text)) {
        semester = 'FA';
    } else if (/(?<![a-z])su(?![a-z])/i.test(text)) {
        semester = 'SU';
    }
 
    if (!year || !semester) {
        console.warn(`[parseTermName] Could not fully parse term name "${termName}" -> year=${year}, semester=${semester}`);
    }
 
    return { year, semester };
}

module.exports = {
    isQuizExamGroup,
    canvasRequest,
    getAllPages,
    getQuizzesByCourseId,
    getUsersByCourseId,
    extractQuizScoresByUser,
    parseTermName,
};