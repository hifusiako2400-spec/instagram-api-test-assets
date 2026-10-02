const CONFIG = {
  SHEET_NAME: '投稿キュー',
  TIMEZONE: 'Asia/Tokyo',
  GRAPH_BASE: 'https://graph.instagram.com',
  STATUS_READY: 'READY',
  STATUS_PUBLISHING: 'PUBLISHING',
  STATUS_PUBLISHED: 'PUBLISHED',
  STATUS_ERROR: 'ERROR',
  APPROVED: 'APPROVED'
};

function saveInstagramAccessToken() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Instagramアクセストークンを保存',
    'Meta Developersで生成したアクセストークンを入力してください。シートには保存せず、Script Propertiesへ保存します。',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const token = res.getResponseText().trim();
  if (!token) throw new Error('アクセストークンが空です。');

  PropertiesService.getScriptProperties().setProperty('IG_ACCESS_TOKEN', token);
  ui.alert('保存しました。アクセストークンはシートには記録していません。');
}

function setupAutomation() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('IG_USER_ID', '29627673026821419');

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processInstagramQueue')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('processInstagramQueue')
    .timeBased()
    .everyMinutes(5)
    .create();

  SpreadsheetApp.getUi().alert('Instagram自動投稿トリガーを設定しました。5分ごとに承認済み投稿を確認します。');
}

function processInstagramQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) throw new Error('投稿キュー シートが見つかりません。');

    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('IG_ACCESS_TOKEN');
    const userId = props.getProperty('IG_USER_ID');

    if (!token) throw new Error('IG_ACCESS_TOKEN が未設定です。saveInstagramAccessToken() を実行してください。');
    if (!userId) throw new Error('IG_USER_ID が未設定です。setupAutomation() を実行してください。');

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const values = sheet.getRange(2, 1, lastRow - 1, 14).getDisplayValues();
    const nowKey = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');

    values.forEach((row, index) => {
      const sheetRow = index + 2;
      const [id, postDate, postTime, purpose, theme, caption, imageUrl, approval, status] = row;

      if (approval !== CONFIG.APPROVED) return;
      if (status !== CONFIG.STATUS_READY) return;
      if (!postDate || !postTime || !imageUrl) return;

      const dueKey = `${postDate} ${postTime}`;
      if (dueKey > nowKey) return;

      publishQueueRow_(sheet, sheetRow, {
        id,
        purpose,
        theme,
        caption,
        imageUrl,
        token,
        userId
      });
    });
  } finally {
    lock.releaseLock();
  }
}

function publishQueueRow_(sheet, rowNumber, item) {
  try {
    sheet.getRange(rowNumber, 9).setValue(CONFIG.STATUS_PUBLISHING);
    sheet.getRange(rowNumber, 13).clearContent();

    const creationId = createMediaContainer_(item.userId, item.imageUrl, item.caption, item.token);
    waitUntilContainerReady_(creationId, item.token);
    const mediaId = publishMedia_(item.userId, creationId, item.token);
    const info = fetchMediaInfo_(mediaId, item.token);

    sheet.getRange(rowNumber, 9).setValue(CONFIG.STATUS_PUBLISHED);
    sheet.getRange(rowNumber, 10).setValue(mediaId);
    sheet.getRange(rowNumber, 11).setValue(info.permalink || '');
    sheet.getRange(rowNumber, 12).setValue(
      info.timestamp
        ? Utilities.formatDate(new Date(info.timestamp), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
        : Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
    );
  } catch (err) {
    sheet.getRange(rowNumber, 9).setValue(CONFIG.STATUS_ERROR);
    sheet.getRange(rowNumber, 13).setValue(String(err && err.message ? err.message : err));
  }
}

function createMediaContainer_(userId, imageUrl, caption, token) {
  const url = `${CONFIG.GRAPH_BASE}/${encodeURIComponent(userId)}/media`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { Authorization: `Bearer ${token}` },
    payload: {
      image_url: imageUrl,
      caption: caption || ''
    },
    muteHttpExceptions: true
  });

  const body = parseJson_(response);
  if (response.getResponseCode() >= 300 || !body.id) {
    throw new Error('コンテナ作成失敗: ' + JSON.stringify(body));
  }
  return body.id;
}

function waitUntilContainerReady_(creationId, token) {
  for (let i = 0; i < 12; i++) {
    const url = `${CONFIG.GRAPH_BASE}/${encodeURIComponent(creationId)}?fields=id,status_code`;
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    });

    const body = parseJson_(response);
    if (response.getResponseCode() >= 300) {
      throw new Error('コンテナ確認失敗: ' + JSON.stringify(body));
    }
    if (body.status_code === 'FINISHED') return;
    if (body.status_code === 'ERROR' || body.status_code === 'EXPIRED') {
      throw new Error('コンテナ処理失敗: ' + JSON.stringify(body));
    }

    Utilities.sleep(5000);
  }

  throw new Error('コンテナ処理が時間内に完了しませんでした。');
}

function publishMedia_(userId, creationId, token) {
  const url = `${CONFIG.GRAPH_BASE}/${encodeURIComponent(userId)}/media_publish`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { Authorization: `Bearer ${token}` },
    payload: { creation_id: creationId },
    muteHttpExceptions: true
  });

  const body = parseJson_(response);
  if (response.getResponseCode() >= 300 || !body.id) {
    throw new Error('公開失敗: ' + JSON.stringify(body));
  }
  return body.id;
}

function fetchMediaInfo_(mediaId, token) {
  const url = `${CONFIG.GRAPH_BASE}/${encodeURIComponent(mediaId)}?fields=id,media_type,permalink,timestamp`;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  });

  const body = parseJson_(response);
  if (response.getResponseCode() >= 300) {
    throw new Error('公開結果取得失敗: ' + JSON.stringify(body));
  }
  return body;
}

function testApiConnection() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('IG_ACCESS_TOKEN');
  if (!token) throw new Error('IG_ACCESS_TOKEN が未設定です。');

  const response = UrlFetchApp.fetch(
    `${CONFIG.GRAPH_BASE}/me?fields=id,username`,
    {
      method: 'get',
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    }
  );

  const body = parseJson_(response);
  if (response.getResponseCode() >= 300) {
    throw new Error('API接続テスト失敗: ' + JSON.stringify(body));
  }

  SpreadsheetApp.getUi().alert(
    `接続成功\nusername: ${body.username}\nid: ${body.id}`
  );
}

function parseJson_(response) {
  const text = response.getContentText();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { raw: text, httpStatus: response.getResponseCode() };
  }
}
