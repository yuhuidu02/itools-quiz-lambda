require("dotenv").config();
const { Pool } = require("pg");

console.log({
    DB_USER: process.env.DB_USER,
    DB_PASS: process.env.DB_PASS,
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_NAME: process.env.DB_NAME,
});


const quizDb = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASS,
    port: Number(process.env.DB_PORT),
    ssl: {
        // require: true,   
        rejectUnauthorized: false,
    }
});

module.exports = {
    quizDb,
    query: (text, params) => pool.query(text, params)
};
