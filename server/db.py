"""Banco de dados SQLite do Welcomely: conexão e esquema."""
import sqlite3

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('profissional', 'cliente', 'auxiliar')),
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Guarda só o hash SHA-256 do token de sessão.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS professionals (
    user_id               INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    title                 TEXT NOT NULL DEFAULT '',
    bio                   TEXT NOT NULL DEFAULT '',
    location              TEXT NOT NULL DEFAULT '',
    requires_confirmation INTEGER NOT NULL DEFAULT 1,
    min_notice_hours      INTEGER NOT NULL DEFAULT 2,
    max_days_ahead        INTEGER NOT NULL DEFAULT 60,
    cancel_notice_hours   INTEGER NOT NULL DEFAULT 12,
    slot_interval_min     INTEGER NOT NULL DEFAULT 30,
    public                INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS services (
    id              INTEGER PRIMARY KEY,
    professional_id INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    duration_min    INTEGER NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1
);

-- Disponibilidade semanal. weekday: 0 = segunda ... 6 = domingo (como no Python).
CREATE TABLE IF NOT EXISTS availability (
    id              INTEGER PRIMARY KEY,
    professional_id INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
    weekday         INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    start_time      TEXT NOT NULL,
    end_time        TEXT NOT NULL
);

-- Períodos bloqueados (férias, compromissos). Datas no formato AAAA-MM-DDTHH:MM, hora local.
CREATE TABLE IF NOT EXISTS blocks (
    id              INTEGER PRIMARY KEY,
    professional_id INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
    starts_at       TEXT NOT NULL,
    ends_at         TEXT NOT NULL,
    reason          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS assistants (
    professional_id INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
    assistant_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (professional_id, assistant_id)
);

CREATE TABLE IF NOT EXISTS appointments (
    id              INTEGER PRIMARY KEY,
    professional_id INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
    service_id      INTEGER NOT NULL REFERENCES services(id),
    client_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    client_name     TEXT NOT NULL,
    client_phone    TEXT NOT NULL DEFAULT '',
    client_email    TEXT NOT NULL DEFAULT '',
    starts_at       TEXT NOT NULL,
    ends_at         TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pendente', 'confirmado', 'cancelado', 'concluido', 'faltou')),
    notes           TEXT NOT NULL DEFAULT '',
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_appt_prof_start ON appointments(professional_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_client ON appointments(client_id, starts_at);
"""


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(path):
    conn = connect(path)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def get_db():
    if "db" not in g:
        g.db = connect(current_app.config["DATABASE"])
    return g.db


def close_db(exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()
