// server.js
const WebSocket = require('ws');
const { Client } = require('node-osc');

// 設定 VMC 預設的接收埠號 (VSeeFace, Unity 預設通常是 39539)
const VMC_PORT = 39539; 
const oscClient = new Client('127.0.0.1', VMC_PORT);

// 建立 WebSocket 伺服器供網頁連線
const wss = new WebSocket.Server({ port: 8080 });

console.log("=========================================");
console.log("🚀 VMC Relay Server 已啟動!");
console.log(`📡 接收網頁資料: ws://localhost:8080`);
console.log(`🎯 轉發 VMC 資料: UDP 127.0.0.1:${VMC_PORT}`);
console.log("=========================================");

wss.on('connection', function connection(ws) {
    console.log('[+] 網頁端已成功連線！開始接收動捕數據...');
    
    ws.on('message', function incoming(message) {
        try {
            const data = JSON.parse(message);
            // 將收到的 JSON 轉換為 OSC 格式發送
            if (data.address && data.args) {
                oscClient.send(data.address, ...data.args);
            }
        } catch (e) {
            console.error("解析錯誤:", e);
        }
    });

    ws.on('close', () => {
        console.log('[-] 網頁端已斷線。');
    });
});