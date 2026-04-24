const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const ses = new SESClient({ region: process.env.AWS_REGION || "us-west-2" });

async function sendAlertEmail({ subject, text }) {
    const from = process.env.ALERT_EMAIL_FROM;
    const to = process.env.ALERT_EMAIL_TO;

    if (!from || !to) {
        console.warn("Alert email not sent: ALERT_EMAIL_FROM or ALERT_EMAIL_TO not set");
        return;
    }

    await ses.send(new SendEmailCommand({
        Source: from,
        Destination: {
            ToAddresses: [to],
        },
        Message: {
            Subject: {
                Data: subject,
            },
            Body: {
                Text: {
                    Data: text,
                },
            },
        },
    }));    
}

module.exports = {
    sendAlertEmail,
};