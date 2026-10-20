const express = require('express');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { networkInterfaces } = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));

// ---------- настройки ----------
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const MAX_PLAYERS = 8;
const MAX_AMOUNT = 1000000000;
const LOG_LIMIT = 100;
const ROLLS_LIMIT = 10;
const ROOM_TTL = 3 * 24 * 60 * 60 * 1000; // комнаты без активности живут 3 дня
const COLORS = ['#ff5a5f', '#3b9cff', '#ffc933', '#2ecc71', '#b36bff', '#ff8a3d', '#1ec8c8', '#ff6bb5'];
const PIN_MAX_FAILS = 5; // столько неверных PIN подряд — и вход в комнату блокируется
const PIN_LOCK_MS = 60 * 1000;

// Ключ шифрования резервной копии комнаты. Нужна переменная окружения BACKUP_SECRET:
// на хостинге с «стираемым» диском (Render free) только она переживает перезапуск сервера.
const BACKUP_SECRET = process.env.BACKUP_SECRET || '';
const BACKUP_KEY = crypto.createHash('sha256').update(BACKUP_SECRET || crypto.randomBytes(32)).digest();

// ---------- хранилище ----------
const rooms = new Map(); // code -> room
const online = new Map(); // "code:playerId" -> число открытых соединений
const pinLocks = new Map(); // code -> { fails, until }

function newToken() {
    return crypto.randomBytes(24).toString('hex');
}

function newPin() {
    return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

// Приводит комнату (из файла или из резервной копии) к ожидаемому виду
function normalizeRoom(room, code) {
    room.code = code;
    room.players.forEach((p) => {
        if (typeof p.token !== 'string' || !p.token) p.token = newToken();
        if (typeof p.pin !== 'string' || !/^\d{4}$/.test(p.pin)) p.pin = newPin();
    });
    // Комнаты без создателя: им становится первый игрок
    if (!room.players.some((p) => p.id === room.hostId)) {
        room.hostId = room.players.length ? room.players[0].id : null;
    }
    room.log = Array.isArray(room.log) ? room.log : [];
    room.rolls = Array.isArray(room.rolls) ? room.rolls : [];
    room.seq = Number(room.seq) || 0;
    room.updated = Number(room.updated) || Date.now();
}

function loadData() {
    if (!fs.existsSync(DATA_FILE)) return;
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        Object.entries(data.rooms || {}).forEach(([code, room]) => {
            if (!room || !Array.isArray(room.players)) return;
            normalizeRoom(room, code);
            rooms.set(code, room);
        });
        console.log(`Загружено комнат: ${rooms.size}`);
    } catch (err) {
        console.error('Ошибка загрузки данных:', err);
    }
}

function serialize() {
    return JSON.stringify({ rooms: Object.fromEntries(rooms) });
}

let saveTimer = null;
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        const tmp = DATA_FILE + '.tmp';
        fs.writeFile(tmp, serialize(), 'utf8', (err) => {
            if (err) return console.error('Ошибка сохранения:', err);
            fs.rename(tmp, DATA_FILE, (err2) => {
                if (err2) console.error('Ошибка сохранения:', err2);
            });
        });
    }, 500);
}

function flushSync() {
    try {
        fs.writeFileSync(DATA_FILE, serialize(), 'utf8');
    } catch (err) {
        console.error('Ошибка сохранения:', err);
    }
}

loadData();

// ---------- вспомогательные функции ----------
function fail(error, extra) {
    return Object.assign({ ok: false, error }, extra);
}

function cleanName(v) {
    return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 15);
}

function parseAmount(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_AMOUNT) return null;
    return n;
}

function parseSetting(v, def, min, max) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) return def;
    return n;
}

function newCode() {
    for (let i = 0; i < 200; i++) {
        const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
        if (!rooms.has(code)) return code;
    }
    return null;
}

// Сравнение секретов без утечки по времени
function secretOk(real, given) {
    if (typeof real !== 'string' || typeof given !== 'string' || !real) return false;
    const a = Buffer.from(real);
    const b = Buffer.from(given);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Проверка PIN игрока при входе «по имени». Возвращает null, если всё хорошо, иначе ответ с ошибкой.
function checkPin(room, player, pin) {
    const now = Date.now();
    const lock = pinLocks.get(room.code) || { fails: 0, until: 0 };
    if (lock.until > now) {
        const sec = Math.ceil((lock.until - now) / 1000);
        return fail('Слишком много попыток. Подождите ' + sec + ' с', { reason: 'locked' });
    }
    const given = String(pin === undefined || pin === null ? '' : pin).trim();
    if (!given) {
        return fail(
            'Имя «' + player.name + '» уже есть в комнате. Введите PIN этого игрока или выберите другое имя',
            { reason: 'need_pin' }
        );
    }
    if (secretOk(player.pin, given)) {
        pinLocks.delete(room.code);
        return null;
    }
    lock.fails += 1;
    if (lock.fails >= PIN_MAX_FAILS) {
        lock.fails = 0;
        lock.until = now + PIN_LOCK_MS;
    }
    pinLocks.set(room.code, lock);
    return fail('Неверный PIN', { reason: 'need_pin' });
}

// ---------- резервная копия комнаты (для банкира) ----------
// Копия сжата и зашифрована ключом сервера: телефон хранит её как «чёрный ящик»,
// прочитать или подправить её нельзя. Принимает её сервер только вместе с личным ключом банкира.
function encryptRoom(room) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', BACKUP_KEY, iv);
    const packed = zlib.deflateSync(Buffer.from(JSON.stringify(room), 'utf8'));
    const enc = Buffer.concat([cipher.update(packed), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decryptRoom(str) {
    try {
        const buf = Buffer.from(str, 'base64');
        if (buf.length < 29) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', BACKUP_KEY, buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(12, 28));
        const packed = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
        return JSON.parse(zlib.inflateSync(packed).toString('utf8'));
    } catch {
        return null;
    }
}

// Пытается поднять комнату, которой нет на сервере, из копии банкира
function tryRestore(code, d) {
    if (typeof d.backup !== 'string' || d.backup.length > 400000) return null;
    if (typeof d.playerId !== 'string' || typeof d.token !== 'string') return null;
    const room = decryptRoom(d.backup);
    if (!room || room.code !== code || !Array.isArray(room.players)) return null;
    if (Date.now() - Number(room.updated) > ROOM_TTL) return null; // слишком старая
    const host = room.players.find((p) => p.id === room.hostId);
    if (!host || host.id !== d.playerId || !secretOk(host.token, d.token)) return null;
    normalizeRoom(room, code);
    rooms.set(code, room);
    console.log(`Комната ${code} восстановлена из копии банкира`);
    return room;
}

function addLog(room, entry) {
    room.seq += 1;
    room.log.push(Object.assign({ id: room.seq, t: Date.now() }, entry));
    if (room.log.length > LOG_LIMIT) room.log.splice(0, room.log.length - LOG_LIMIT);
}

function addRoll(room, player, a, b) {
    room.seq += 1;
    room.rolls.push({ id: room.seq, t: Date.now(), by: player.name, byId: player.id, a, b });
    if (room.rolls.length > ROLLS_LIMIT) room.rolls.splice(0, room.rolls.length - ROLLS_LIMIT);
}

function addPlayer(room, name) {
    const used = room.players.map((p) => p.color);
    const color = COLORS.find((c) => !used.includes(c)) || COLORS[room.players.length % COLORS.length];
    const player = {
        id: crypto.randomUUID(), // публичный: его видят все игроки
        token: newToken(), // секретный ключ входа: знает только сам игрок и сервер
        pin: newPin(), // личный PIN для возврата, если телефон забыл вход
        name,
        balance: room.startBalance,
        color
    };
    room.players.push(player);
    addLog(room, { type: 'join', name, byId: player.id });
    return player;
}

// То, что видят все игроки. token и pin сюда попадать не должны.
function publicState(room) {
    return {
        code: room.code,
        hostId: room.hostId,
        startBalance: room.startBalance,
        goAmount: room.goAmount,
        players: room.players.map((p) => ({
            id: p.id,
            name: p.name,
            balance: p.balance,
            color: p.color,
            online: online.has(room.code + ':' + p.id)
        })),
        log: room.log,
        rolls: room.rolls
    };
}

function broadcast(room) {
    io.to(room.code).emit('state', publicState(room));
}

// Свежую копию получает только банкир (на всех его открытых устройствах)
function sendBackup(room) {
    const ids = io.sockets.adapter.rooms.get(room.code);
    if (!ids) return;
    let blob = null;
    ids.forEach((id) => {
        const s = io.sockets.sockets.get(id);
        if (s && s.data && s.data.playerId === room.hostId) {
            if (!blob) blob = encryptRoom(room);
            s.emit('backup', blob);
        }
    });
}

function commit(room) {
    room.updated = Date.now();
    scheduleSave();
    broadcast(room);
    sendBackup(room);
}

function joinReply(room, player) {
    const host = room.hostId === player.id;
    const reply = {
        ok: true,
        code: room.code,
        playerId: player.id,
        token: player.token,
        pin: player.pin,
        name: player.name,
        host
    };
    if (host) reply.backup = encryptRoom(room);
    return reply;
}

function handle(fn) {
    return (data, ack) => {
        let result;
        try {
            result = fn(data && typeof data === 'object' ? data : {});
        } catch (err) {
            console.error('Ошибка обработчика:', err);
            result = fail('Ошибка сервера');
        }
        if (typeof ack === 'function') ack(result);
    };
}

// ---------- сокеты ----------
io.on('connection', (socket) => {
    socket.data = {};

    function current() {
        const room = rooms.get(socket.data.code);
        const me = room && room.players.find((p) => p.id === socket.data.playerId);
        return room && me ? { room, me } : null;
    }

    function release() {
        const { code, playerId } = socket.data;
        if (!code) return;
        const key = code + ':' + playerId;
        const n = (online.get(key) || 0) - 1;
        if (n > 0) online.set(key, n);
        else online.delete(key);
        socket.data = {};
        const room = rooms.get(code);
        if (room) broadcast(room); // только «в сети / не в сети», без сохранения
    }

    function attach(room, player) {
        if (socket.data.code) {
            socket.leave(socket.data.code);
            release();
        }
        socket.data = { code: room.code, playerId: player.id };
        socket.join(room.code);
        const key = room.code + ':' + player.id;
        online.set(key, (online.get(key) || 0) + 1);
    }

    socket.on('create_room', handle((d) => {
        const name = cleanName(d.name);
        if (!name) return fail('Введите имя');
        const code = newCode();
        if (!code) return fail('Не удалось создать комнату, попробуйте позже');
        const room = {
            code,
            hostId: null,
            startBalance: parseSetting(d.startBalance, 1500, 0, MAX_AMOUNT),
            goAmount: parseSetting(d.goAmount, 200, 0, MAX_AMOUNT),
            players: [],
            log: [],
            rolls: [],
            seq: 0,
            created: Date.now(),
            updated: Date.now()
        };
        rooms.set(code, room);
        const player = addPlayer(room, name);
        room.hostId = player.id; // создатель комнаты — банкир
        attach(room, player);
        commit(room);
        return joinReply(room, player);
    }));

    socket.on('join_room', handle((d) => {
        const code = String(d.code === undefined || d.code === null ? '' : d.code).trim();
        let room = rooms.get(code);
        // Сервер мог перезапуститься и забыть комнату: банкир может поднять её из своей копии
        if (!room) room = tryRestore(code, d);
        if (!room) return fail('Комната не найдена', { reason: 'no_room' });

        // 1) Вход по личному ключу (id публичный, одного его недостаточно)
        let player = null;
        if (typeof d.playerId === 'string' && typeof d.token === 'string') {
            const p = room.players.find((x) => x.id === d.playerId);
            if (p && secretOk(p.token, d.token)) player = p;
        }

        if (!player) {
            // Автоматический вход никогда не ищет по имени и не добавляет новых игроков
            if (d.strict) return fail('Вас нет в этой комнате. Войдите заново.', { reason: 'no_player' });

            const name = cleanName(d.name);
            if (!name) return fail('Введите имя');
            const same = room.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
            if (same) {
                // 2) Имя уже занято: зайти за этого игрока можно только с его PIN
                const bad = checkPin(room, same, d.pin);
                if (bad) return bad;
                player = same;
            } else {
                if (room.players.length >= MAX_PLAYERS) return fail('В комнате уже ' + MAX_PLAYERS + ' игроков');
                player = addPlayer(room, name);
            }
        }
        attach(room, player);
        commit(room);
        return joinReply(room, player);
    }));

    socket.on('leave', handle(() => {
        if (socket.data.code) {
            socket.leave(socket.data.code);
            release();
        }
        return { ok: true };
    }));

    // Игрок переводит деньги другому игроку или банку
    socket.on('pay', handle((d) => {
        const c = current();
        if (!c) return fail('Вы не в комнате');
        const amount = parseAmount(d.amount);
        if (!amount) return fail('Неверная сумма');
        if (c.me.balance < amount) return fail('Недостаточно денег');

        if (d.to === 'bank') {
            c.me.balance -= amount;
            addLog(c.room, { type: 'pay', from: c.me.name, fromId: c.me.id, to: 'Банк', toId: 'bank', amount, by: c.me.name, byId: c.me.id });
        } else {
            const to = c.room.players.find((p) => p.id === d.to);
            if (!to) return fail('Получатель не найден');
            if (to.id === c.me.id) return fail('Нельзя платить самому себе');
            c.me.balance -= amount;
            to.balance += amount;
            addLog(c.room, { type: 'pay', from: c.me.name, fromId: c.me.id, to: to.name, toId: to.id, amount, by: c.me.name, byId: c.me.id });
        }
        commit(c.room);
        return { ok: true };
    }));

    // Банк выдаёт деньги игроку
    socket.on('bank_give', handle((d) => {
        const c = current();
        if (!c) return fail('Вы не в комнате');
        if (c.room.hostId !== c.me.id) return fail('Банк доступен только создателю комнаты');
        const amount = parseAmount(d.amount);
        if (!amount) return fail('Неверная сумма');
        const to = c.room.players.find((p) => p.id === d.to);
        if (!to) return fail('Игрок не найден');
        to.balance += amount;
        addLog(c.room, { type: 'give', from: 'Банк', fromId: 'bank', to: to.name, toId: to.id, amount, by: c.me.name, byId: c.me.id });
        commit(c.room);
        return { ok: true };
    }));

    // Банк забирает деньги у игрока
    socket.on('bank_take', handle((d) => {
        const c = current();
        if (!c) return fail('Вы не в комнате');
        if (c.room.hostId !== c.me.id) return fail('Банк доступен только создателю комнаты');
        const amount = parseAmount(d.amount);
        if (!amount) return fail('Неверная сумма');
        const from = c.room.players.find((p) => p.id === d.from);
        if (!from) return fail('Игрок не найден');
        if (from.balance < amount) return fail('У игрока недостаточно денег');
        from.balance -= amount;
        addLog(c.room, { type: 'take', from: from.name, fromId: from.id, to: 'Банк', toId: 'bank', amount, by: c.me.name, byId: c.me.id });
        commit(c.room);
        return { ok: true };
    }));

    // Бросок кубиков (результат считает телефон, сервер только записывает)
    socket.on('dice', handle((d) => {
        const c = current();
        if (!c) return fail('Вы не в комнате');
        const a = Number(d.a);
        const b = Number(d.b);
        const valid = (n) => Number.isInteger(n) && n >= 1 && n <= 6;
        if (!valid(a) || !valid(b)) return fail('Неверный бросок');
        addRoll(c.room, c.me, a, b);
        commit(c.room);
        return { ok: true };
    }));

    socket.on('remove_player', handle((d) => {
        const c = current();
        if (!c) return fail('Вы не в комнате');
        if (c.room.hostId !== c.me.id) return fail('Это может только создатель комнаты');
        if (d.id === c.me.id) return fail('Нельзя удалить самого себя');
        const idx = c.room.players.findIndex((p) => p.id === d.id);
        if (idx === -1) return fail('Игрок не найден');
        const [removed] = c.room.players.splice(idx, 1);
        addLog(c.room, { type: 'remove', name: removed.name, by: c.me.name, byId: c.me.id });
        commit(c.room);
        return { ok: true };
    }));

    socket.on('reset_game', handle(() => {
        const c = current();
        if (!c) return fail('Вы не в комнате');
        if (c.room.hostId !== c.me.id) return fail('Это может только создатель комнаты');
        c.room.players.forEach((p) => { p.balance = c.room.startBalance; });
        c.room.log = [];
        c.room.rolls = [];
        addLog(c.room, { type: 'reset', amount: c.room.startBalance, by: c.me.name, byId: c.me.id });
        commit(c.room);
        return { ok: true };
    }));

    // Банкир закрывает комнату: она удаляется у всех, телефоны возвращаются на экран входа
    socket.on('close_room', handle(() => {
        const c = current();
        if (!c) return fail('Вы не в комнате');
        if (c.room.hostId !== c.me.id) return fail('Это может только создатель комнаты');
        const code = c.room.code;
        io.to(code).emit('room_closed');
        const ids = io.sockets.adapter.rooms.get(code);
        Array.from(ids || []).forEach((id) => {
            const s = io.sockets.sockets.get(id);
            if (s) {
                s.leave(code);
                s.data = {};
            }
        });
        Array.from(online.keys()).forEach((key) => {
            if (key.startsWith(code + ':')) online.delete(key);
        });
        pinLocks.delete(code);
        rooms.delete(code);
        scheduleSave();
        return { ok: true };
    }));

    socket.on('disconnect', () => release());
});

// Чистим давно заброшенные комнаты
setInterval(() => {
    const now = Date.now();
    let removed = false;
    rooms.forEach((room, code) => {
        if (now - room.updated > ROOM_TTL) {
            rooms.delete(code);
            pinLocks.delete(code);
            removed = true;
        }
    });
    if (removed) scheduleSave();
}, 60 * 60 * 1000).unref();

// Сохраняем при остановке сервера
['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => {
        if (saveTimer) flushSync(); // дописываем только если есть несохранённые изменения
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    const nets = networkInterfaces();
    console.log('\n========================================');
    console.log('🎩 Монополия — терминал запущен!');
    console.log('========================================');
    console.log(`\n💻 На этом компьютере:\n   http://localhost:${PORT}`);
    console.log('\n📱 На телефоне (в той же Wi-Fi сети):');
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`   http://${net.address}:${PORT}`);
            }
        }
    }
    if (!BACKUP_SECRET) {
        console.log('\nℹ️  BACKUP_SECRET не задан: восстановление комнаты после перезапуска сервера отключено.');
        console.log('   (На своём компьютере это не страшно: комнаты хранятся в data.json.)');
    }
    console.log('\n========================================');
    console.log('Нажмите Ctrl+C, чтобы остановить сервер.');
});
