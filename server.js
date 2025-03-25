import express from "express";
import fetch from "node-fetch";
import qs from "querystring";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { toJalaali } from "jalaali-js";
import https from 'https';
import http from 'http';

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configFile = path.join(__dirname, "dvhost.config");
if (!fs.existsSync(configFile)) {
    console.error("Error: Configuration file 'dvhost.config' not found!");
    process.exit(1);
}

const config = fs.readFileSync(configFile, "utf-8")
    .split("\n")
    .reduce((acc, line) => {
        const index = line.indexOf("=");
        if (index !== -1) {
            const key = line.substring(0, index).trim();
            const value = line.substring(index + 1).trim();
            if (key && value) {
                acc[key] = value;
            }
        }
        return acc;
    }, {});

const {
    HOST: dvhost_host,
    PORT: dvhost_port,
    PATH: dvhost_path,
    USERNAME,
    PASSWORD,
    PROTOCOL,
    SUBSCRIPTION,
    PUBLIC_KEY_PATH,
    PRIVATE_KEY_PATH,
    TEMPLATE_NAME,
    SUB_HTTP_PORT,
    SUB_HTTPS_PORT,
    TELEGRAM_URL,
} = config;

const dvhost_loginData = { username: USERNAME, password: PASSWORD };

const convertToJalali = (timestamp) => {
    const date = new Date(timestamp);
    const jalaaliDate = toJalaali(date.getFullYear(), date.getMonth() + 1, date.getDate());
    return `${jalaaliDate.jy}/${jalaaliDate.jm}/${jalaaliDate.jd}`;
};

app.use(express.static(path.join(__dirname, "public")));
app.set("views", path.join(__dirname, `views/templates/${TEMPLATE_NAME}`));
app.set("view engine", "ejs");

function isBrowserRequest(userAgent) {
    const browserKeywords = [
        'Mozilla', 'Chrome', 'Safari', 'Edge', 'Opera', 'Firefox', 'Trident', 'WebKit'
    ];
    return browserKeywords.some(keyword => userAgent.includes(keyword));
}

//app.get("/sub/:subId", async (req, res) => {
app.get("/" + SUBSCRIPTION.split('/')[3] + "/:subId", async (req, res) => {
    try {
        const targetSubId = req.params.subId;
        const userAgent = req.headers['user-agent'];

        const loginResponse = await fetch(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: qs.stringify(dvhost_loginData),
        });

        if (!loginResponse.ok) throw new Error("Login request failed.");

        const loginResult = await loginResponse.json();
        if (!loginResult.success) throw new Error(loginResult.msg || "Login unsuccessful");

        const listResponse = await fetch(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/inbounds/list`, {
            method: "GET",
            headers: {
                "Cookie": loginResponse.headers.get("set-cookie"),
                "Accept": "application/json",
            },
        });

        if (!listResponse.ok) throw new Error("List request failed.");

        const contentType = listResponse.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            throw new Error("List response is not JSON.");
        }

        const listResult = await listResponse.json();

        const foundClient = listResult.obj.flatMap((inbound) => {
            const settings = JSON.parse(inbound.settings);
            return settings.clients;
        }).find(client => client.subId === targetSubId);

        if (!foundClient) return res.json({ message: "No object found with the specified subId." });

        const trafficResponse = await fetch(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/inbounds/getClientTraffics/${foundClient.email}`, {
            method: "GET",
            headers: {
                "Cookie": loginResponse.headers.get("set-cookie"),
                "Accept": "application/json",
            },
        });

        if (!trafficResponse.ok) throw new Error("Traffic request failed.");

        const trafficData = await trafficResponse.json();

        const expiryTimeJalali = convertToJalali(trafficData.obj.expiryTime);

        const suburl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const suburl_content = await fetchUrlContent(SUBSCRIPTION + targetSubId);
        const Backup_link = config.Backup_link || "";
        
        if (userAgent && isBrowserRequest(userAgent)) {
            res.render("sub", {
                data: {
                    ...trafficData.obj,
                    expiryTimeJalali,
                    suburl,
                    suburl_content,
                    get_backup_link: Backup_link,
                    TELEGRAM_URL
                },
            });
        } else {
            const base64BackupLink = Buffer.from(Backup_link, 'utf-8').toString('base64');
            const decodedBackupLink = Buffer.from(base64BackupLink, 'base64').toString('utf-8');
            
            const decodedSuburlContent = Buffer.from(suburl_content, 'base64').toString('utf-8');
            
            const combinedContent = decodedBackupLink + '\n' + decodedSuburlContent;
            
            const combinedBase64 = Buffer.from(combinedContent, 'utf-8').toString('base64');
            
            res.send(combinedBase64);
        }
    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

async function fetchUrlContent(url) {
    try {
        const agent = new https.Agent({
            rejectUnauthorized: false
        });

        const response = await fetch(url, { agent });

        if (!response.ok) {
            throw new Error(`Failed to fetch URL: ${url}, Status: ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        console.error(`Error fetching URL: ${url}`, error.message);
        throw error;
    }
}

http.createServer(app).listen(SUB_HTTP_PORT, () => {
    console.log(`HTTP Server is running at ${SUBSCRIPTION}:${SUB_HTTP_PORT}`);
});

if (PUBLIC_KEY_PATH && PRIVATE_KEY_PATH && fs.existsSync(PUBLIC_KEY_PATH) && fs.existsSync(PRIVATE_KEY_PATH)) {
    const options = {
        key: fs.readFileSync(PRIVATE_KEY_PATH),
        cert: fs.readFileSync(PUBLIC_KEY_PATH)
    };
    https.createServer(options, app).listen(SUB_HTTPS_PORT, () => {
        console.log(`HTTPS Server is running at ${SUBSCRIPTION}:${SUB_HTTPS_PORT}`);
    });
} else {
    console.warn('SSL certificates not found. Only HTTP server is running.');
}
