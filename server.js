const express = require('express');
const http = require('http');
const crypto = require('crypto');
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

// ---------- хранилище ----------
const rooms = new Map(); // code -> room
const online = new Map(); // "code:playerId" -> число открытых соединений

function loadData() {
    if (!fs.existsSync(DATA_FILE)) return;
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        Object.entries(data.rooms || {}).forEach(([code, room]) => {
            if (!room || !Array.isArray(room.players)) return;
            room.code = code;
            // Старые комнаты без создателя: им становится первый игрок (он и создавал комнату)
            if (!room.players.some((p) => p.id === room.hostId)) {
                room.hostId = room.players.length ? room.players[0].id : null;
            }
            room.log = Array.isArray(room.log) ? room.log : [];
            room.rolls = Array.isArray(room.rolls) ? room.rolls : [];
            room.seq = Number(room.seq) || 0;
            room.updated = Number(room.updated) || Date.now();
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
function fail(error) {
    return { ok: false, error };
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
        id: crypto.randomUUID(),
        name,
        balance: room.startBalance,
        color
    };
    room.players.push(player);
    addLog(room, { type: 'join', name, byId: player.id });
    return player;
}

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

function commit(room) {
    room.updated = Date.now();
    scheduleSave();
    broadcast(room);
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
        return { ok: true, code, playerId: player.id, name: player.name, host: true };
    }));

    socket.on('join_room', handle((d) => {
        const code = String(d.code === undefined || d.code === null ? '' : d.code).trim();
        const room = rooms.get(code);
        if (!room) return fail('Комната не найдена');
        let player = typeof d.playerId === 'string' ? room.players.find((p) => p.id === d.playerId) : null;
        if (!player) {
            const name = cleanName(d.name);
            if (!name) return fail('Введите имя');
            // то же имя = тот же игрок (например, если телефон забыл сессию)
            player = room.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
            if (player) {
                // Нельзя «зайти за другого», пока он в сети (иначе можно занять место банкира)
                if (online.has(code + ':' + player.id)) {
                    return fail('Это имя сейчас занято. Если это вы — подождите минуту и попробуйте снова');
                }
            } else {
                if (room.players.length >= MAX_PLAYERS) return fail('В комнате уже ' + MAX_PLAYERS + ' игроков');
                player = addPlayer(room, name);
            }
        }
        attach(room, player);
        commit(room);
        return { ok: true, code, playerId: player.id, name: player.name, host: room.hostId === player.id };
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
    console.log('\n========================================');
    console.log('Нажмите Ctrl+C, чтобы остановить сервер.');
});
