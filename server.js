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
const httpPort = 2082;
const httpsPort = 2083;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load configuration from dvhost.config
const configFile = path.join(__dirname, "dvhost.config");
if (!fs.existsSync(configFile)) {
    console.error("Error: Configuration file 'dvhost.config' not found!");
    process.exit(1);
}

const config = {};

// Read the config file
const data = fs.readFileSync(configFile, 'utf8');

// Parse the lines
data.split('\n').forEach(line => {
    const trimmedLine = line.trim();

    // Skip empty lines and comments
    if (!trimmedLine || trimmedLine.startsWith('#')) return;

    // Split only at the first '='
    const [key, ...valueParts] = trimmedLine.split('=');
    const value = valueParts.join('='); // Rejoin the remaining parts

    // Save the key-value pair
    config[key.trim()] = value.replace(/\\n/g, '\n');
});


const { 
    HOST: dvhost_host, 
    PORT: dvhost_port, 
    PATH: dvhost_path, 
    USERNAME, 
    PASSWORD, 
    PROTOCOL,
    SUBSCRIPTION,
    PUBLIC_KEY_PATH, // مسیر گواهی عمومی
    PRIVATE_KEY_PATH, // مسیر کلید خصوصی
    TELEGRAM_URL,
    BACKUP,
} = config;

const dvhost_loginData = { username: USERNAME, password: PASSWORD };

// Helper function to convert timestamp to Jalali date
const convertToJalali = (timestamp) => {
    const date = new Date(timestamp);
    const jalaaliDate = toJalaali(date.getFullYear(), date.getMonth() + 1, date.getDate());
    return `${jalaaliDate.jy}/${jalaaliDate.jm}/${jalaaliDate.jd}`;
};

app.use(express.static(path.join(__dirname, "public")));
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

function isBrowserRequest(userAgent) {
    const browserKeywords = [
        'Mozilla', 'Chrome', 'Safari', 'Edge', 'Opera', 'Firefox', 'Trident', 'WebKit'
    ];
    return browserKeywords.some(keyword => userAgent.includes(keyword));
}

app.get("/sub/:subId", async (req, res) => {
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
        let suburl_content = await fetchUrlContent(SUBSCRIPTION + targetSubId);
        suburl_content += "\n" + BACKUP;
        let random = "&custom=encode" + Math.trunc(Math.random() * 343532152345);
        const result = suburl_content.replace(/(.*)#/, `$1${random}#`);
        suburl_content = Buffer.from(result).toString('base64')
	    console.log("suburl_content",suburl_content);

        if (userAgent && isBrowserRequest(userAgent)) {
            res.render("sub", {
                data: {
                    ...trafficData.obj,
                    expiryTimeJalali,
                    suburl,
                    TELEGRAM_URL
                },
            });
        } else {
            res.send(suburl_content);
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

http.createServer(app).listen(httpPort, () => {
    console.log(`HTTP Server is running at ${SUBSCRIPTION}:${httpsPort}`);
});

if (PUBLIC_KEY_PATH && PRIVATE_KEY_PATH && fs.existsSync(PUBLIC_KEY_PATH) && fs.existsSync(PRIVATE_KEY_PATH)) {
    const options = {
        key: fs.readFileSync(PRIVATE_KEY_PATH),
        cert: fs.readFileSync(PUBLIC_KEY_PATH)
    };
    https.createServer(options, app).listen(httpsPort, () => {
        console.log(`HTTPS Server is running at ${SUBSCRIPTION}:${httpsPort}`);
    });
} else {
    console.warn('SSL certificates not found. Only HTTP server is running.');
}
