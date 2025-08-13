const { Client } = require('@line/bot-sdk');
const { google } = require('googleapis');

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// Google Sheets 設定
const sheets = google.sheets('v4');
const auth = new google.auth.GoogleAuth({
  credentials: {
    type: 'service_account',
    project_id: 'izo-fcm',
    private_key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    client_id: '123456789012345678901',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.GOOGLE_SHEETS_CLIENT_EMAIL}`
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// 問卷問題設定
const SURVEY_QUESTIONS = [
  {
    id: 1,
    text: '您好!歡迎加入IZO運動館!請問您的姓名是?',
    type: 'text'
  },
  {
    id: 2,
    text: '請問您的電話是?',
    type: 'text'
  },
  {
    id: 3,
    text: '請問您的Email是?',
    type: 'text'
  },
  {
    id: 4,
    text: '請問您的年齡是?',
    type: 'quick_reply',
    options: ['18-25', '26-35', '36-45', '46+']
  },
  {
    id: 5,
    text: '您最喜歡的運動項目是?',
    type: 'quick_reply',
    options: ['重訓', '有氧', '瑜珈', '游泳', '其他']
  },
  {
    id: 6,
    text: '您希望收到什麼樣的健身資訊?',
    type: 'quick_reply',
    options: ['課程資訊', '營養建議', '運動技巧', '優惠活動']
  },
  {
    id: 7,
    text: '您通常什麼時間可以運動?',
    type: 'quick_reply',
    options: ['早上', '下午', '晚上']
  },
  {
    id: 8,
    text: '您有特別的健身目標嗎?',
    type: 'quick_reply',
    options: ['減重', '增肌', '健康維持', '其他']
  }
];

// 用戶狀態儲存（在記憶體中，生產環境建議使用資料庫）
const userStates = new Map();

// 速率限制器
class RateLimiter {
  constructor(maxRequests = 2, timeWindow = 60000) {
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
    this.requests = [];
  }

  async waitForSlot() {
    const now = Date.now();
    this.requests = this.requests.filter(time => now - time < this.timeWindow);
    
    if (this.requests.length >= this.maxRequests) {
      const waitTime = this.timeWindow - (now - this.requests[0]);
      console.log(`速率限制：等待 ${waitTime/1000} 秒...`);
      await delay(waitTime);
    }
    
    this.requests.push(now);
  }
}

// 全域速率限制器
const rateLimiter = new RateLimiter(2, 60000); // 每分鐘最多 2 個請求

// 建立 LINE Bot 客戶端
const client = new Client(config);

// 延遲函數
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 智能重試機制
async function sendMessageWithSmartRetry(userId, message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // 等待速率限制
      await rateLimiter.waitForSlot();
      
      // 發送訊息
      await client.pushMessage(userId, message);
      console.log(`訊息發送成功: ${userId}`);
      return true;
    } catch (error) {
      if (error.statusCode === 429 && i < maxRetries - 1) {
        const waitTime = Math.pow(2, i) * 60000; // 指數退避：1分鐘、2分鐘
        console.log(`429 錯誤，等待 ${waitTime/1000} 秒後重試... (第 ${i+1} 次重試)`);
        await delay(waitTime);
        continue;
      }
      console.error(`訊息發送失敗: ${error.message}`);
      throw error;
    }
  }
  throw new Error('重試次數已用完');
}

// 主要 webhook 處理函數
module.exports = async (req, res) => {
  // 設定 CORS 標頭
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 處理 OPTIONS 請求
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // 處理 GET 請求（測試用）
  if (req.method === 'GET') {
    res.status(200).json({
      message: 'IZO LINE Bot 問卷系統 - Vercel 版本',
      status: 'running',
      rateLimit: '每分鐘最多 2 個請求'
    });
    return;
  }

  // 處理 POST 請求（LINE webhook）
  if (req.method === 'POST') {
    try {
      const events = req.body.events;
      
      if (events && events.length > 0) {
        for (const event of events) {
          await handleEvent(event);
        }
      }

      res.status(200).json({ message: 'OK' });
    } catch (error) {
      console.error('Webhook Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};

// 處理 LINE 事件
async function handleEvent(event) {
  try {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleTextMessage(event.source.userId, event.message.text);
    } else if (event.type === 'follow') {
      await handleFollowEvent(event.source.userId);
    }
  } catch (error) {
    console.error('Handle Event Error:', error);
    await logToSheet('錯誤', event.source.userId, 0, `事件處理錯誤: ${error.message}`);
  }
}

// 處理追蹤事件（新用戶）
async function handleFollowEvent(userId) {
  try {
    await logToSheet('新用戶', userId, 0, '追蹤');
    
    userStates.set(userId, {
      currentQuestion: 1,
      answers: {},
      startTime: new Date().toISOString()
    });
    
    const message = { type: 'text', text: '您好!歡迎加入IZO運動館!請問您的姓名是?' };
    await sendMessageWithSmartRetry(userId, message);
    
    await delay(5000); // 5 秒延遲
    await logToSheet('發送問題', userId, 1, '姓名');
  } catch (error) {
    console.error('Follow Event Error:', error);
    await logToSheet('錯誤', userId, 0, `追蹤事件錯誤: ${error.message}`);
  }
}

// 處理文字訊息
async function handleTextMessage(userId, message) {
  try {
    // 檢查特殊指令
    if (message === '測試問題') {
      userStates.set(userId, {
        currentQuestion: 1,
        answers: {},
        startTime: new Date().toISOString()
      });
      
      const startMessage = { type: 'text', text: '🧪 測試模式啟動！開始問卷...' };
      await sendMessageWithSmartRetry(userId, startMessage);
      
      await delay(5000); // 5 秒延遲
      await sendQuestion(userId, 1);
      await logToSheet('測試重置', userId, 0, '測試問題指令');
      return;
    }

    let userState = userStates.get(userId);

    if (!userState) {
      userState = {
        currentQuestion: 1,
        answers: {},
        startTime: new Date().toISOString()
      };
      userStates.set(userId, userState);
      
      const welcomeMessage = { type: 'text', text: '您好!歡迎加入IZO運動館!請問您的姓名是?' };
      await sendMessageWithSmartRetry(userId, welcomeMessage);
      
      await delay(5000); // 5 秒延遲
      await logToSheet('發送問題', userId, 1, '姓名');
      return;
    }

    const currentQuestionIndex = userState.currentQuestion;
    const question = SURVEY_QUESTIONS[currentQuestionIndex - 1];

    if (!question) {
      await completeSurvey(userId);
      userStates.delete(userId);
      return;
    }

    // 儲存答案
    userState.answers[question.id] = message;
    await logToSheet('用戶回答', userId, question.id, message);

    // 推進到下一題
    userState.currentQuestion++;

    if (userState.currentQuestion > SURVEY_QUESTIONS.length) {
      await completeSurvey(userId);
      userStates.delete(userId);
    } else {
      await delay(10000); // 10 秒延遲
      await sendQuestion(userId, userState.currentQuestion);
    }
  } catch (error) {
    console.error('Handle Text Message Error:', error);
    await logToSheet('錯誤', userId, 0, `處理文字訊息錯誤: ${error.message}`);
  }
}

// 發送問題
async function sendQuestion(userId, questionNumber) {
  try {
    const question = SURVEY_QUESTIONS[questionNumber - 1];
    let message;

    if (question.type === 'text') {
      message = { type: 'text', text: question.text };
    } else if (question.type === 'quick_reply') {
      const quickReplyItems = question.options.map(option => ({
        type: 'action',
        action: {
          type: 'message',
          label: option,
          text: option
        }
      }));

      message = {
        type: 'text',
        text: `第${questionNumber}題: ${question.text}`,
        quickReply: {
          items: quickReplyItems
        }
      };
    }

    await sendMessageWithSmartRetry(userId, message);
    await delay(5000); // 5 秒延遲
    await logToSheet('發送問題', userId, question.id, question.text);
  } catch (error) {
    console.error('Send Question Error:', error);
    await logToSheet('錯誤', userId, 0, `發送問題錯誤: ${error.message}`);
  }
}

// 完成問卷
async function completeSurvey(userId) {
  try {
    const userState = userStates.get(userId);
    if (userState) {
      await saveQuestionnaireResult(userId, userState);
      
      const completionMessage = { 
        type: 'text', 
        text: '🎉 問卷完成! 感謝您提供寶貴的資訊,我們會根據您的需求為您安排最適合的服務。如有任何問題,歡迎隨時詢問我們的服務人員!\n\n 提示：輸入「測試問題」可以重新開始問卷。' 
      };
      
      await sendMessageWithSmartRetry(userId, completionMessage);
      await delay(5000); // 5 秒延遲
      await logToSheet('問卷完成', userId, 0, '問卷已完成');
    }
  } catch (error) {
    console.error('Complete Survey Error:', error);
    await logToSheet('錯誤', userId, 0, `完成問卷錯誤: ${error.message}`);
  }
}

// 儲存完整問卷結果
async function saveQuestionnaireResult(userId, userState) {
  try {
    const authClient = await auth.getClient();
    const timestamp = new Date().toISOString();
    
    const values = [[
      userId,
      userState.answers[1] || '',
      userState.answers[2] || '',
      userState.answers[3] || '',
      userState.answers[4] || '',
      userState.answers[5] || '',
      userState.answers[6] || '',
      userState.answers[7] || '',
      userState.answers[8] || '',
      timestamp
    ]];

    const resultSheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const resultSheetName = '問卷結果';
    const range = `${resultSheetName}!A1:J1`;

    const getResponse = await sheets.spreadsheets.values.get({
      auth: authClient,
      spreadsheetId: resultSheetId,
      range: range,
    });

    if (!getResponse.data.values || getResponse.data.values.length === 0) {
      const headerValues = [
        ['用戶ID', '姓名', '電話', 'Email', '年齡', '運動項目', '健身資訊', '運動時間', '健身目標', '完成時間']
      ];
      await sheets.spreadsheets.values.update({
        auth: authClient,
        spreadsheetId: resultSheetId,
        range: range,
        valueInputOption: 'RAW',
        resource: { values: headerValues },
      });
      console.log('問卷結果表標題已建立。');
    }

    await sheets.spreadsheets.values.append({
      auth: authClient,
      spreadsheetId: resultSheetId,
      range: `${resultSheetName}!A:J`,
      valueInputOption: 'RAW',
      resource: { values: values },
    });
    console.log('問卷結果已儲存。');
  } catch (error) {
    console.error('Save Questionnaire Result Error:', error);
    await logToSheet('錯誤', userId, 0, `儲存問卷結果錯誤: ${error.message}`);
  }
}

// 記錄到 Google Sheets (工作表1)
async function logToSheet(action, userId, questionIndex, answer) {
  try {
    const authClient = await auth.getClient();
    const timestamp = new Date().toISOString();
    const values = [[timestamp, action, userId, questionIndex, answer]];

    await sheets.spreadsheets.values.append({
      auth: authClient,
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range: '工作表1!A:E',
      valueInputOption: 'RAW',
      resource: { values: values },
    });
  } catch (error) {
    console.error('Log to Sheet Error:', error);
  }
}
