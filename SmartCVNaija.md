SmartCVNaija
A CV job matching bot that allows users to search jobs, apply, and upload CVs via WhatsApp and Telegram. Supports payments via Paystack, CV analysis with OpenAI, and recruiter email notifications.
Setup

Install Node.js, PostgreSQL, Redis, ClamAV, and Nginx on your VPS.
Clone the repo: git clone https://github.com/your-username/smartcvnaija.git
Install dependencies: npm install
Set up .env with API keys and SMTP settings.
Create database: psql -U postgres -d cv_job_matching -f schema.sql
Start: pm2 start server.js --name "smartcvnaija"

Features

Job search and application via WhatsApp/Telegram.
CV upload with malware scanning and text extraction.
Cover letter generation.
Paystack payment integration (500 Naira).
Recruiter email notifications via shared hosting SMTP.
