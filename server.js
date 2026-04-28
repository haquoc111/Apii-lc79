const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static('public')); // để phục vụ file HTML có nhạc

// ----------------------------- DỮ LIỆU LỊCH SỬ TỪ FILE TXT -----------------------------
// Hàm parse một file .txt dạng bảng
function parseHistoryFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const sessions = [];
    for (let line of lines) {
        // Tìm dòng có dạng: STT   ID         Kết quả      Xúc xắc            Điểm
        const match = line.match(/\d+\s+(\d+)\s+(TAI|XIU)\s+\[(\d+),(\d+),(\d+)\]\s+(\d+)/);
        if (match) {
            sessions.push({
                id: match[1],
                result: match[2],
                dice: [parseInt(match[3]), parseInt(match[4]), parseInt(match[5])],
                total: parseInt(match[6])
            });
        }
    }
    return sessions;
}

// Gom tất cả lịch sử từ các file (đặt đúng tên file trong thư mục data/)
const historyFiles = [
    '1.txt', '2.txt', '3.txt', '4.txt', '5.txt', '6.txt', '7.txt', '8.txt'
];
let allSessions = [];
historyFiles.forEach(file => {
    try {
        const filePath = path.join(__dirname, 'data', file);
        if (fs.existsSync(filePath)) {
            const sessions = parseHistoryFile(filePath);
            allSessions.push(...sessions);
        }
    } catch(e) { console.log(`Không đọc được ${file}`); }
});
// Sắp xếp theo thời gian (dùng id tăng dần)
allSessions.sort((a,b) => parseInt(a.id) - parseInt(b.id));
console.log(`Đã load ${allSessions.length} phiên từ lịch sử`);

// ----------------------------- XÂY DỰNG THUẬT TOÁN CẦU -----------------------------
// Tạo pattern từ chuỗi kết quả (độ dài len)
function getPattern(sessions, index, len=2) {
    if (index < len) return null;
    return sessions.slice(index-len, index).map(s => s.result).join('-');
}

// Thống kê tất cả pattern có thể có
const patternStats = new Map(); // key = pattern, value = { tai: 0, xiu: 0, total: 0, correctRate: 0 }
for (let i = 2; i < allSessions.length; i++) {
    const pattern = getPattern(allSessions, i, 2);
    const nextResult = allSessions[i].result;
    if (!pattern) continue;
    if (!patternStats.has(pattern)) {
        patternStats.set(pattern, { tai: 0, xiu: 0, total: 0 });
    }
    const stat = patternStats.get(pattern);
    if (nextResult === 'TAI') stat.tai++;
    else stat.xiu++;
    stat.total++;
    stat.correctRate = Math.max(stat.tai, stat.xiu) / stat.total;
    patternStats.set(pattern, stat);
}

// Hàm dự đoán dựa vào 2 phiên gần nhất và tổng điểm hiện tại (nếu có)
function predictByPatternAndScore(last2Results, lastScore) {
    // Mặc định nếu không có pattern thì dùng điểm
    let defaultPrediction = (lastScore && lastScore > 11) ? 'TAI' : ((lastScore && lastScore < 11) ? 'XIU' : null);
    
    if (last2Results && last2Results.length === 2) {
        const pattern = last2Results.join('-');
        if (patternStats.has(pattern)) {
            const stat = patternStats.get(pattern);
            const predicted = (stat.tai >= stat.xiu) ? 'TAI' : 'XIU';
            const confidence = Math.round(stat.correctRate * 100);
            return { prediction: predicted, confidence, method: 'pattern' };
        }
    }
    // Fallback: dùng điểm
    if (defaultPrediction) {
        return { prediction: defaultPrediction, confidence: 60, method: 'score' };
    }
    return { prediction: 'TAI', confidence: 50, method: 'random' };
}

// ----------------------------- LẤY DỮ LIỆU TỪ API GỐC -----------------------------
const API_CONFIG = {
    lc79: {
        tx: 'https://wtx.tele68.com/v1/tx/lite-sessions?cp=R&cl=R&pf=web&at=f086fe7af8278bae0ec455dadb3910de',
        md5: 'https://wtxmd52.tele68.com/v1/txmd5/sessions?cp=R&cl=R&pf=web&at=f086fe7af8278bae0ec455dadb3910de'
    },
    betvip: {
        tx: 'https://wtx.macminim6.online/v1/tx/lite-sessions?cp=R&cl=R&pf=web&at=8a0d738d6e675bb490e53ae5b522d0df',
        md5: 'https://wtxmd52.macminim6.online/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=8a0d738d6e675bb490e53ae5b522d0df'
    }
};

// Gọi API gốc và lấy phiên hiện tại + lịch sử gần nhất
async function fetchGameData(url) {
    try {
        const response = await axios.get(url);
        const data = response.data;
        // Tuỳ cấu trúc API, giả sử trả về mảng sessions, mỗi session có { result, dice, total, id }
        if (data && data.sessions && data.sessions.length > 0) {
            const sessions = data.sessions;
            const lastSession = sessions[sessions.length - 1];
            const prevSession = sessions.length >= 2 ? sessions[sessions.length - 2] : null;
            return { lastSession, prevSession, allSessions: sessions };
        }
        return null;
    } catch (error) {
        console.error('Lỗi gọi API:', error.message);
        return null;
    }
}

// Hàm trả về JSON theo mẫu yêu cầu
async function buildResponse(apiUrl, gameType) {
    const gameData = await fetchGameData(apiUrl);
    if (!gameData) {
        return { error: 'Không thể lấy dữ liệu từ API gốc' };
    }
    const { lastSession, prevSession, allSessions } = gameData;
    
    // Lấy 2 kết quả gần nhất để tạo pattern
    let last2Results = [];
    if (prevSession) last2Results.push(prevSession.result);
    if (lastSession) last2Results.push(lastSession.result);
    
    const lastScore = lastSession ? lastSession.total : null;
    const { prediction, confidence, method } = predictByPatternAndScore(last2Results, lastScore);
    
    // Xác định pattern dang cau (vd: TAI-TAI)
    const dang_cau = last2Results.length === 2 ? last2Results.join('') : 'khong du';
    
    return {
        id: "@hahakk123",   // của bạn
        phien_hien_tai: lastSession ? lastSession.id : 'unknown',
        ket_qua: lastSession ? lastSession.result : '?',
        xuc_xac: lastSession ? lastSession.dice.join('-') : '?-?-?',
        du_doan: prediction,
        do_tin_cay: `${confidence}%`,
        dinh_dang_cau: dang_cau,
        phuong_phap: method
    };
}

// ----------------------------- CÁC ENDPOINT GET -----------------------------
app.get('/api/taixiu/lc79', async (req, res) => {
    const result = await buildResponse(API_CONFIG.lc79.tx, 'lc79_tx');
    res.json(result);
});

app.get('/api/taixiumd5/lc79', async (req, res) => {
    const result = await buildResponse(API_CONFIG.lc79.md5, 'lc79_md5');
    res.json(result);
});

app.get('/api/taixiu/betvip', async (req, res) => {
    const result = await buildResponse(API_CONFIG.betvip.tx, 'betvip_tx');
    res.json(result);
});

app.get('/api/taixiumd5/betvip', async (req, res) => {
    const result = await buildResponse(API_CONFIG.betvip.md5, 'betvip_md5');
    res.json(result);
});

// ----------------------------- GIAO DIỆN WEB + NHẠC -----------------------------
// File HTML tĩnh có nhạc nền (có thể thêm nhiều bài)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server chạy tại http://localhost:${PORT}`);
    console.log(`- Tài Xỉu LC79: http://localhost:${PORT}/api/taixiu/lc79`);
    console.log(`- MD5 LC79: http://localhost:${PORT}/api/taixiumd5/lc79`);
    console.log(`- Tài Xỉu Betvip: http://localhost:${PORT}/api/taixiu/betvip`);
    console.log(`- MD5 Betvip: http://localhost:${PORT}/api/taixiumd5/betvip`);
});