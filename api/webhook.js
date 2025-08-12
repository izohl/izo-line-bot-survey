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
    text: '您好!歡迎加入IZO健身中心!請問您的姓名是?',
    type: 'text'
  },
  {
    id: 2,
    text: '請問您的年齡是?',
    type: 'quick_reply',
    options: ['18-25', '26-35', '36-45', '46+']
  },
  {
    id: 3,
    text: '您最喜歡的運動項目是?(可多選)',
    type: 'quick_reply',
    options: ['重訓', '有氧', '瑜珈', '游泳', '其他']
  },
  {
    id: 4,
    text: '您希望收到什麼樣的健身資訊?(可多選)',
    type: 'quick_reply',
    options: ['課程資訊', '營養建議', '運動技巧', '優惠活動']
  },
  {
    id: 5,
    text: '您通常什麼時間可以運動?(可多選)',
    type: 'quick_reply',
    options: ['早上', '下午', '晚上']
  },
  {
    id: 6,
    text: '您有特別的健身目標嗎?',
    type: 'quick_reply',
    options: ['減重', '增肌', '健康維持', '其他']
  }
];

// 用戶狀態儲存（在記憶體中，生產環境建議使用資料庫）
const userStates = new Map();

// 建立 LINE Bot 客戶端
const client = new Client(config);

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
      status: 'running'
    });
    return;
  }

  // 處理 POST 請求（LINE webhook）
  if (req.method === 'POST') {
    try {
      // 簡化簽名驗證 - 暫時跳過
      // 注意：在生產環境中應該要驗證簽名
      
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
  }
}

// 處理追蹤事件（新用戶）
async function handleFollowEvent(userId) {
  try {
    // 初始化用戶狀態
    userStates.set(userId, {
      currentQuestion: 1,
      answers: {},
      startTime: new Date().toISOString()
    });

    // 發送歡迎訊息和第一題
    await sendQuestion(userId, 1);
    
    // 記錄到 Google Sheets
    await logToSheet('新用戶追蹤', userId, 0, '開始問卷');
    
  } catch (error) {
    console.error('Follow Event Error:', error);
  }
}

// 處理文字訊息
async function handleTextMessage(userId, message) {
  try {
    // 檢查特殊指令
    if (message === '測試問題') {
      // 重置用戶狀態並開始問卷
      userStates.set(userId, {
        currentQuestion: 1,
        answers: {},
        startTime: new Date().toISOString()
      });
      
      // 發送開始訊息
      await client.pushMessage(userId, {
        type: 'text',
        text: '🧪 測試模式啟動！開始問卷...'
      });
      
      // 發送第一題
      await sendQuestion(userId, 1);
      
      // 記錄測試重置
      await logToSheet('測試重置', userId, 0, '測試問題指令');
      return; // 重要：這裡要 return，避免繼續執行
    }

    const userState = userStates.get(userId);
    
    if (!userState) {
      // 如果沒有狀態，發送說明訊息
      await client.pushMessage(userId, {
        type: 'text',
        text: '您好！請輸入「測試問題」來開始問卷，或直接回答問題。'
      });
      return;
    }

    const currentQuestion = SURVEY_QUESTIONS[userState.currentQuestion - 1];
    
    // 儲存答案
    if (currentQuestion.type === 'quick_reply') {
      // 處理多選答案 - 簡化邏輯
      if (!userState.answers[currentQuestion.id]) {
        userState.answers[currentQuestion.id] = [];
      }
      userState.answers[currentQuestion.id].push(message);
      
      // 記錄答案到 Google Sheets
      await logToSheet('用戶回答', userId, currentQuestion.id, message);
      
      // 自動進入下一題（簡化多選處理）
      if (userState.currentQuestion < SURVEY_QUESTIONS.length) {
        userState.currentQuestion++;
        await sendQuestion(userId, userState.currentQuestion);
      } else {
        // 問卷完成
        await completeSurvey(userId);
      }
    } else {
      // 單選題
      userState.answers[currentQuestion.id] = message;
      
      // 記錄答案到 Google Sheets
      await logToSheet('用戶回答', userId, currentQuestion.id, message);

      // 檢查是否還有下一題
      if (userState.currentQuestion < SURVEY_QUESTIONS.length) {
        userState.currentQuestion++;
        await sendQuestion(userId, userState.currentQuestion);
      } else {
        // 問卷完成
        await completeSurvey(userId);
      }
    }
    
  } catch (error) {
    console.error('Text Message Error:', error);
  }
}

// 發送問題
async function sendQuestion(userId, questionNumber) {
  try {
    const question = SURVEY_QUESTIONS[questionNumber - 1];
    let message;

    if (question.type === 'quick_reply') {
      // 建立 Quick Reply 按鈕
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
    } else {
      message = {
        type: 'text',
        text: `第${questionNumber}題: ${question.text}`
      };
    }

    await client.pushMessage(userId, message);
    
  } catch (error) {
    console.error('Send Question Error:', error);
  }
}

// 完成問卷
async function completeSurvey(userId) {
  try {
    const userState = userStates.get(userId);
    
    // 發送完成訊息
    const completionMessage = {
      type: 'text',
      text: '🎉 問卷完成! 感謝您提供寶貴的資訊,我們會根據您的需求為您安排最適合的服務。如有任何問題,歡迎隨時詢問我們的服務人員!\n\n 提示：輸入「測試問題」可以重新開始問卷。'
    };
    
    await client.pushMessage(userId, completionMessage);

    // 儲存完整結果到 Google Sheets
    await saveQuestionnaireResult(userId, userState);

    // 清除用戶狀態
    userStates.delete(userId);
    
  } catch (error) {
    console.error('Complete Survey Error:', error);
  }
}

// 記錄到 Google Sheets
async function logToSheet(action, userId, questionIndex, answer) {
  try {
    const authClient = await auth.getClient();
    const timestamp = new Date().toISOString();
    
    const values = [
      [timestamp, action, userId, questionIndex, answer]
    ];

    await sheets.spreadsheets.values.append({
      auth: authClient,
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range: '工作表1!A:E',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values }
    });

    console.log('Log to Sheet Success:', action, userId);
    
  } catch (error) {
    console.error('Log to Sheet Error:', error);
  }
}

// 儲存完整問卷結果
async function saveQuestionnaireResult(userId, userState) {
  try {
    const authClient = await auth.getClient();
    const timestamp = new Date().toISOString();
    
    // 準備資料，確保欄位順序正確
    const values = [[
      userId, // A: 用戶ID
      userState.answers[1] || '', // B: 姓名
      userState.answers[2] || '', // C: 年齡
      Array.isArray(userState.answers[3]) ? userState.answers[3].join(', ') : (userState.answers[3] || ''), // D: 運動項目
      Array.isArray(userState.answers[4]) ? userState.answers[4].join(', ') : (userState.answers[4] || ''), // E: 健身資訊
      Array.isArray(userState.answers[5]) ? userState.answers[5].join(', ') : (userState.answers[5] || ''), // F: 運動時間
      Array.isArray(userState.answers[6]) ? userState.answers[6].join(', ') : (userState.answers[6] || ''), // G: 健身目標
      timestamp // H: 完成時間
    ]];

    console.log('準備儲存的資料:', values[0]); // 加入除錯訊息

    await sheets.spreadsheets.values.append({
      auth: authClient,
      spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range: '問卷結果!A:H', // 確保範圍是 A:H
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values }
    });

    console.log('Save Result Success:', userId);
    
  } catch (error) {
    console.error('Save Result Error:', error);
    console.error('用戶狀態:', userState);
    console.error('準備的資料:', values);
  }
}
