import express from "express";
import dotenv from "dotenv";
import postgres from "postgres";

const envPath = process.env.ENV_CODE;
if (!envPath) {
  throw new Error('ENV_CODE is not set');
}
dotenv.config({ path: envPath });
const app = express();

app.set("trust proxy", true);

const twitchClientId = process.env.TWITCH_CLIENT_ID;
const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET;
const postgresPassword = process.env.POSTGRES_PASSWORD;

// Function to get Twitch access token
async function getTwitchAccessToken() {
    const res = await fetch(`https://id.twitch.tv/oauth2/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `client_id=${twitchClientId}&client_secret=${twitchClientSecret}&grant_type=client_credentials`
    });
    const data = await res.json();
    return{ 
        access_token: data.access_token ,
        expires_in: data.expires_in,
        token_type: data.token_type
    };
}

async function getUserInfo(accessToken) {
    console.log("Fetching user info...");
    const userinfoRes = await fetch('https://id.twitch.tv/oauth2/userinfo', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`,  // accessToken is already a string
        }
    });
    const userinfoData = await userinfoRes.json();
    // Don't log PII in production
    if (process.env.NODE_ENV !== 'production') {
        console.log(userinfoData);
    }
    return userinfoData;
}

// Initialize PostgreSQL connection
const sql = postgres(`postgres://nesi:${postgresPassword}@127.0.0.1:5432/twitchapidb`,{
    host                 : '127.0.0.1',            // Postgres ip address[s] or domain name[s]
    port                 : 5432,          // Postgres server port[s]
    database             : 'twitchapidb',            // Name of database to connect to
    username             : 'nesi',            // Username of database user
    password             : `${postgresPassword}`,            // Password of database user
});

async function saveUserToken(userId, username, accessToken, refreshToken) {
    await sql`
        INSERT INTO users (uid, username, access_token, refresh_token)
        VALUES (${userId}, ${username}, ${accessToken}, ${refreshToken})
        ON CONFLICT (uid) DO UPDATE
        SET access_token = ${accessToken},
            refresh_token = ${refreshToken},
            updated_at = NOW()
    `;
}


app.use((req, res, next) => {
  // cors
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.get("/api/twitch-queue/auth", async (req, res) => {
    req.query.code = null;
    const redirectUri = "http://localhost:8080/api/twitch-queue/oauth/authorize";
    const scopes = "user:read:email";
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${twitchClientId}&force_verify=true&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
    res.redirect(authUrl);
});

app.get("/api/twitch-queue/oauth/authorize", async (req, res) => {
    const code = req.query.code;

    if (!code || typeof code !== 'string' || code.length > 512) {
        return res.status(400).json({ error: 'Invalid authorization code' });
    }

    try {
        const tokenResponse = await fetch(`https://id.twitch.tv/oauth2/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `client_id=${twitchClientId}&client_secret=${twitchClientSecret}&code=${code}&grant_type=authorization_code&redirect_uri=http://localhost:8080/api/twitch-queue/oauth/authorize`
        });
        const tokenData = await tokenResponse.json();

        const userInfo = await getUserInfo(tokenData.access_token);
        await saveUserToken(userInfo.sub, userInfo.preferred_username, tokenData.access_token, tokenData.refresh_token);

        res.redirect(`https://card.nesiexe.xyz/`);
    } catch (err) {
        console.error('Error exchanging authorization code for access token:', err);
        res.status(500).json({ error: 'Failed to exchange authorization code for access token' });
    }
});



app.listen(8080, '127.0.0.1', () => {
    console.log("Server is running on http://localhost:8080");
    console.log("to auth go to http://localhost:8080/api/twitch-queue/auth");
});
