const line = require('@line/bot-sdk');
const { google } = require('googleapis');

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

// 問卷問題設定
const QUESTIONS = [
  "您好！歡迎加入IZO健身中心！請問您的姓名是？",
  "請問您的年齡是？",
  "您最喜歡的運動項目是？(可多選：重訓/有氧/瑜珈/游泳/其他)",
  "您希望收到什麼樣的健身資訊？(可多選：課程資訊/營養建議/運動技巧/優惠活動)",
  "您通常什麼時間可以運動？(可多選：早上/下午/晚上)",
  "您有特別的健身目標嗎？(減重/增肌/健康維持/其他)"
];

const WELCOME_MESSAGE = 
  "歡迎加入IZO健身中心！\n\n" +
  "我們會透過幾個簡單問題來了解您的需求，為您提供最適合的服務。\n\n" +
  "準備好了嗎？讓我們開始吧！";

const COMPLETION_MESSAGE = 
  "問卷完成！\n\n" +
  "感謝您提供寶貴的資訊，我們會根據您的需求為您安排最適合的服務。\n\n" +
  "如有任何問題，歡迎隨時詢問我們的服務人員！";

// 儲存用戶問卷狀態 (在生產環境中應該使用資料庫)
let userStates = {};

// 處理 LINE webhook 事件
async function handleEvent(event) {
  try {
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const userMessage = event.message.text;
      
      // 處理用戶回答
      await processUserResponse(userId, userMessage);
    } else if (event.type === 'follow') {
      // 新用戶加入
      const userId = event.source.userId;
      await processNewUser(userId);
    }
  } catch (error) {
    console.error('Handle Event Error:', error);
  }
}

// 處理新用戶加入
async function processNewUser(userId) {
  try {
    // 初始化用戶問卷狀態
    userStates[userId] = {
      userId: userId,
      currentQuestionIndex: -1,
      answers: [],
      startTime: new Date(),
      isCompleted: false
    };
    
    // 發送歡迎訊息
    await sendMessage(userId, WELCOME_MESSAGE);
    
    // 發送第一題
    await sendNextQuestion(userId);
    
    // 記錄到Google Sheets
    await logToSheet('新用戶加入', userId, '', '');
  } catch (error) {
    console.error('Process New User Error:', error);
  }
}

// 處理用戶回答
async function processUserResponse(userId, message) {
  try {
    // 檢查用戶狀態
    if (!userStates[userId]) {
      userStates[userId] = {
        userId: userId,
        currentQuestionIndex: -1,
        answers: [],
        startTime: new Date(),
        isCompleted: false
      };
    }
    
    const userState = userStates[userId];
    
    // 儲存用戶回答
    if (userState.currentQuestionIndex >= 0 && userState.currentQuestionIndex < QUESTIONS.length - 1) {
      userState.answers.push(message);
      
      // 記錄到Google Sheets
      await logToSheet('用戶回答', userId, userState.currentQuestionIndex + 1, message);
    }
    
    // 發送下一題
    await sendNextQuestion(userId);
  } catch (error) {
    console.error('Process User Response Error:', error);
  }
}

// 發送下一題
async function sendNextQuestion(userId) {
  try {
    const userState = userStates[userId];
    userState.currentQuestionIndex++;
    
    if (userState.currentQuestionIndex < QUESTIONS.length) {
      const questionMessage = `第${userState.currentQuestionIndex + 1}題：\n${QUESTIONS[userState.currentQuestionIndex]}`;
      await sendMessage(userId, questionMessage);
    } else {
      // 問卷完成
      await sendMessage(userId, COMPLETION_MESSAGE);
      
      // 儲存完整問卷結果
      await saveQuestionnaireResult(userState);
      
      // 清除用戶狀態
      delete userStates[userId];
    }
  } catch (error) {
    console.error('Send Next Question Error:', error);
  }
}

// 發送LINE訊息
async function sendMessage(userId, message) {
  try {
    await client.pushMessage(userId, {
      type: 'text',
      text: message
    });
  } catch (error) {
    console.error('Send Message Error:', error);
  }
}

// 記錄到Google Sheets
async function logToSheet(action, userId, questionIndex, answer) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        private_key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    const timestamp = new Date().toISOString();
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range: 'Sheet1!A:E',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [[timestamp, action, userId, questionIndex, answer]]
      }
    });
  } catch (error) {
    console.error('Log to Sheet Error:', error);
  }
}

// 儲存完整問卷結果
async function saveQuestionnaireResult(userState) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        private_key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    const endTime = new Date();
    const durationMinutes = Math.round((endTime - userState.startTime) / (1000 * 60));
    
    const row = [
      endTime.toISOString(),
      userState.userId,
      userState.startTime.toISOString(),
      endTime.toISOString(),
      durationMinutes,
      userState.answers[0] || '',
      userState.answers[1] || '',
      userState.answers[2] || '',
      userState.answers[3] || '',
      userState.answers[4] || '',
      userState.answers[5] || ''
    ];
    
    // 檢查是否有問卷結果工作表，如果沒有則建立
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
        range: '問卷結果!A:L',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: [row]
        }
      });
    } catch (error) {
      // 如果問卷結果工作表不存在，先建立標題列
      const headers = [
        '時間戳記', '用戶ID', '開始時間', '完成時間', '完成時間(分鐘)',
        '姓名', '年齡', '喜愛運動', '資訊偏好', '運動時間', '健身目標'
      ];
      
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
        range: '問卷結果!A:L',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: [headers, row]
        }
      });
    }
    
    // 記錄完成事件
    await logToSheet('問卷完成', userState.userId, '全部', '完成');
    
  } catch (error) {
    console.error('Save Result Error:', error);
  }
}

// Vercel 函數入口點
module.exports = async (req, res) => {
  // 設定 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'GET') {
    res.status(200).json({ message: 'IZO LINE Bot 問卷系統 - Vercel 版本' });
    return;
  }

  if (req.method === 'POST') {
    try {
      // 驗證 LINE 簽名
      const signature = req.headers['x-line-signature'];
      if (!signature) {
        console.error('Missing LINE signature');
        res.status(400).json({ error: 'Missing signature' });
        return;
      }

      // 處理 LINE webhook 事件
      const events = req.body.events;
      if (events && events.length > 0) {
        for (const event of events) {
          await handleEvent(event);
        }
      }

      // 回應 LINE 平台
      res.status(200).json({ message: 'OK' });
    } catch (error) {
      console.error('Webhook Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};
