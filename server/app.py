"""Welcomely — API de agendamento de atendimentos (FERMATools).

Perfis: profissional (quem atende), cliente (quem agenda) e auxiliar (secretaria,
que gerencia a agenda de um ou mais profissionais).

Uso:  python app.py   (serve a API em /api e o app web da pasta ../web)
"""
import hashlib
import os
import re
import secrets
from datetime import date, datetime, timedelta
from functools import wraps
from zoneinfo import ZoneInfo

from flask import Blueprint, Flask, current_app, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash

from db import close_db, get_db, init_db
from slots import compute_slots, fmt_dt, has_conflict, minutes, parse_dt

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROLES = ("profissional", "cliente", "auxiliar")
STATUSES = ("pendente", "confirmado", "cancelado", "concluido", "faltou")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
PROFILE_FIELDS = {
    "title": str, "bio": str, "location": str,
    "requires_confirmation": bool, "public": bool,
    "min_notice_hours": int, "max_days_ahead": int, "cancel_notice_hours": int, "slot_interval_min": int,
}

api = Blueprint("api", __name__, url_prefix="/api")


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


@api.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify(error=err.message), err.status


# ---------------------------------------------------------------- utilidades

def now_local():
    return datetime.now(ZoneInfo(current_app.config["TIMEZONE"])).replace(tzinfo=None, second=0, microsecond=0)


def body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def text(data, key, required=False, max_len=500):
    value = data.get(key, "")
    value = "" if value is None else str(value).strip()
    if required and not value:
        raise ApiError(f"Campo obrigatório: {key}.")
    return value[:max_len]


def parse_day(value):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ApiError("Data inválida (use AAAA-MM-DD).")


def parse_time(value):
    if not isinstance(value, str) or not HHMM_RE.match(value):
        raise ApiError("Horário inválido (use HH:MM).")
    return value


def hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def public_user(row):
    return {"id": row["id"], "name": row["name"], "email": row["email"], "phone": row["phone"], "role": row["role"]}


def new_session(user_id):
    token = secrets.token_urlsafe(32)
    get_db().execute("INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)", (hash_token(token), user_id))
    return token


def load_user():
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    return get_db().execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
        (hash_token(header[7:]),),
    ).fetchone()


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        g.user = load_user()
        if g.user is None:
            raise ApiError("Faça login para continuar.", 401)
        return fn(*args, **kwargs)
    return wrapper


def get_professional(pid):
    prof = get_db().execute(
        "SELECT p.*, u.name, u.email, u.phone FROM professionals p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?",
        (pid,),
    ).fetchone()
    if prof is None:
        raise ApiError("Profissional não encontrado.", 404)
    return prof


def can_manage(user, pid):
    """O próprio profissional ou um auxiliar vinculado a ele."""
    if user is None:
        return False
    if user["id"] == pid and user["role"] == "profissional":
        return True
    return get_db().execute(
        "SELECT 1 FROM assistants WHERE professional_id = ? AND assistant_id = ?", (pid, user["id"])
    ).fetchone() is not None


def require_manager(pid):
    get_professional(pid)
    if not can_manage(g.user, pid):
        raise ApiError("Você não gerencia a agenda deste profissional.", 403)


def require_owner(pid):
    get_professional(pid)
    if g.user["id"] != pid:
        raise ApiError("Apenas o próprio profissional pode alterar isto.", 403)


def managed_professionals(user):
    db = get_db()
    if user["role"] == "profissional":
        rows = db.execute(
            "SELECT u.id, u.name, p.title FROM users u JOIN professionals p ON p.user_id = u.id WHERE u.id = ?",
            (user["id"],),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT u.id, u.name, p.title FROM assistants a JOIN users u ON u.id = a.professional_id"
            " JOIN professionals p ON p.user_id = u.id WHERE a.assistant_id = ? ORDER BY u.name",
            (user["id"],),
        ).fetchall()
    return [dict(r) for r in rows]


def profile_dict(prof, full=False):
    data = {
        "id": prof["user_id"], "name": prof["name"], "title": prof["title"], "bio": prof["bio"],
        "location": prof["location"], "requires_confirmation": bool(prof["requires_confirmation"]),
        "min_notice_hours": prof["min_notice_hours"], "max_days_ahead": prof["max_days_ahead"],
        "cancel_notice_hours": prof["cancel_notice_hours"],
    }
    if full:
        data.update(slot_interval_min=prof["slot_interval_min"], public=bool(prof["public"]),
                    email=prof["email"], phone=prof["phone"])
    return data


def service_dict(row):
    return {"id": row["id"], "name": row["name"], "description": row["description"],
            "duration_min": row["duration_min"], "active": bool(row["active"])}


def get_service(sid, pid=None):
    row = get_db().execute("SELECT * FROM services WHERE id = ?", (sid,)).fetchone()
    if row is None or (pid is not None and row["professional_id"] != pid):
        raise ApiError("Serviço não encontrado.", 404)
    return row


APPT_SELECT = (
    "SELECT a.*, s.name AS service_name, s.duration_min, pu.name AS professional_name, p.title AS professional_title,"
    " p.location AS professional_location"
    " FROM appointments a JOIN services s ON s.id = a.service_id"
    " JOIN users pu ON pu.id = a.professional_id JOIN professionals p ON p.user_id = a.professional_id"
)


def appt_dict(row):
    return {
        "id": row["id"], "professional_id": row["professional_id"], "professional_name": row["professional_name"],
        "professional_title": row["professional_title"], "professional_location": row["professional_location"],
        "service_id": row["service_id"], "service_name": row["service_name"],
        "client_id": row["client_id"], "client_name": row["client_name"], "client_phone": row["client_phone"],
        "client_email": row["client_email"], "starts_at": row["starts_at"], "ends_at": row["ends_at"],
        "status": row["status"], "notes": row["notes"], "created_at": row["created_at"],
    }


def get_appointment(aid):
    row = get_db().execute(APPT_SELECT + " WHERE a.id = ?", (aid,)).fetchone()
    if row is None:
        raise ApiError("Agendamento não encontrado.", 404)
    return row


def add_defaults_for_professional(db, pid):
    """Serviço e horários iniciais, para o profissional já começar com algo editável."""
    db.execute("INSERT INTO professionals (user_id) VALUES (?)", (pid,))
    db.execute("INSERT INTO services (professional_id, name, duration_min) VALUES (?, 'Atendimento', 30)", (pid,))
    for weekday in range(5):
        db.executemany(
            "INSERT INTO availability (professional_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)",
            [(pid, weekday, "09:00", "12:00"), (pid, weekday, "14:00", "18:00")],
        )


# ------------------------------------------------------------------ contas

@api.post("/auth/register")
def register():
    data = body()
    name = text(data, "name", required=True, max_len=120)
    email = text(data, "email", required=True, max_len=200).lower()
    phone = text(data, "phone", max_len=40)
    password = str(data.get("password") or "")
    role = data.get("role")
    if not EMAIL_RE.match(email):
        raise ApiError("E-mail inválido.")
    if len(password) < 6:
        raise ApiError("A senha deve ter pelo menos 6 caracteres.")
    if role not in ROLES:
        raise ApiError("Perfil inválido.")
    db = get_db()
    if db.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        raise ApiError("Já existe uma conta com este e-mail.", 409)
    cur = db.execute(
        "INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)",
        (name, email, phone, generate_password_hash(password), role),
    )
    if role == "profissional":
        add_defaults_for_professional(db, cur.lastrowid)
    token = new_session(cur.lastrowid)
    db.commit()
    user = db.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(token=token, user=public_user(user)), 201


@api.post("/auth/login")
def login():
    data = body()
    email = text(data, "email").lower()
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if user is None or not check_password_hash(user["password_hash"], str(data.get("password") or "")):
        raise ApiError("E-mail ou senha incorretos.", 401)
    token = new_session(user["id"])
    db.commit()
    return jsonify(token=token, user=public_user(user))


@api.post("/auth/logout")
@login_required
def logout():
    db = get_db()
    db.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(request.headers["Authorization"][7:]),))
    db.commit()
    return jsonify(ok=True)


@api.get("/me")
@login_required
def me():
    data = {"user": public_user(g.user), "manages": []}
    if g.user["role"] in ("profissional", "auxiliar"):
        data["manages"] = managed_professionals(g.user)
    if g.user["role"] == "profissional":
        data["profile"] = profile_dict(get_professional(g.user["id"]), full=True)
    return jsonify(data)


@api.put("/me")
@login_required
def update_me():
    data = body()
    db = get_db()
    name = text(data, "name", required=True, max_len=120)
    phone = text(data, "phone", max_len=40)
    db.execute("UPDATE users SET name = ?, phone = ? WHERE id = ?", (name, phone, g.user["id"]))
    if data.get("new_password"):
        if not check_password_hash(g.user["password_hash"], str(data.get("current_password") or "")):
            raise ApiError("Senha atual incorreta.", 403)
        if len(str(data["new_password"])) < 6:
            raise ApiError("A nova senha deve ter pelo menos 6 caracteres.")
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                   (generate_password_hash(str(data["new_password"])), g.user["id"]))
    db.commit()
    return jsonify(user=public_user(db.execute("SELECT * FROM users WHERE id = ?", (g.user["id"],)).fetchone()))


# ------------------------------------------------------------ profissionais

@api.get("/professionals")
def list_professionals():
    q = f"%{request.args.get('q', '').strip()}%"
    rows = get_db().execute(
        "SELECT p.*, u.name, u.email, u.phone FROM professionals p JOIN users u ON u.id = p.user_id"
        " WHERE p.public = 1 AND (u.name LIKE ? OR p.title LIKE ? OR p.location LIKE ?) ORDER BY u.name LIMIT 100",
        (q, q, q),
    ).fetchall()
    return jsonify(professionals=[profile_dict(r) for r in rows])


@api.get("/professionals/<int:pid>")
def professional_detail(pid):
    prof = get_professional(pid)
    services = get_db().execute(
        "SELECT * FROM services WHERE professional_id = ? AND active = 1 ORDER BY name", (pid,)
    ).fetchall()
    return jsonify(professional=profile_dict(prof), services=[service_dict(s) for s in services])


@api.put("/professionals/<int:pid>/profile")
@login_required
def update_profile(pid):
    require_owner(pid)
    data = body()
    updates = {}
    for field, kind in PROFILE_FIELDS.items():
        if field not in data:
            continue
        value = data[field]
        if kind is str:
            updates[field] = str(value or "").strip()[:2000]
        elif kind is bool:
            updates[field] = 1 if value else 0
        else:
            try:
                updates[field] = max(0, int(value))
            except (TypeError, ValueError):
                raise ApiError(f"Valor inválido para {field}.")
    if updates.get("slot_interval_min") == 0 or updates.get("max_days_ahead") == 0:
        raise ApiError("Intervalo entre horários e janela de agendamento devem ser maiores que zero.")
    if updates:
        sets = ", ".join(f"{k} = ?" for k in updates)
        db = get_db()
        db.execute(f"UPDATE professionals SET {sets} WHERE user_id = ?", (*updates.values(), pid))
        db.commit()
    return jsonify(profile=profile_dict(get_professional(pid), full=True))


@api.get("/professionals/<int:pid>/slots")
def slots(pid):
    prof = get_professional(pid)
    day = parse_day(request.args.get("date"))
    service = get_service(request.args.get("service_id", type=int), pid)
    manager = can_manage(load_user(), pid)
    return jsonify(date=day.isoformat(),
                   slots=compute_slots(get_db(), prof, service["duration_min"], day, now_local(), not manager))


# ---------------------------------------------------------------- serviços

@api.get("/professionals/<int:pid>/services")
@login_required
def list_services(pid):
    require_manager(pid)
    rows = get_db().execute(
        "SELECT * FROM services WHERE professional_id = ? ORDER BY active DESC, name", (pid,)
    ).fetchall()
    return jsonify(services=[service_dict(r) for r in rows])


def service_values(data):
    try:
        duration = int(data.get("duration_min"))
    except (TypeError, ValueError):
        raise ApiError("Duração inválida.")
    if not 5 <= duration <= 600:
        raise ApiError("A duração deve ficar entre 5 e 600 minutos.")
    return (text(data, "name", required=True, max_len=120), text(data, "description", max_len=1000),
            duration, 1 if data.get("active", True) else 0)


@api.post("/professionals/<int:pid>/services")
@login_required
def create_service(pid):
    require_manager(pid)
    db = get_db()
    cur = db.execute(
        "INSERT INTO services (professional_id, name, description, duration_min, active) VALUES (?, ?, ?, ?, ?)",
        (pid, *service_values(body())),
    )
    db.commit()
    return jsonify(service=service_dict(get_service(cur.lastrowid))), 201


@api.put("/services/<int:sid>")
@login_required
def update_service(sid):
    service = get_service(sid)
    require_manager(service["professional_id"])
    db = get_db()
    db.execute("UPDATE services SET name = ?, description = ?, duration_min = ?, active = ? WHERE id = ?",
               (*service_values(body()), sid))
    db.commit()
    return jsonify(service=service_dict(get_service(sid)))


@api.delete("/services/<int:sid>")
@login_required
def delete_service(sid):
    service = get_service(sid)
    require_manager(service["professional_id"])
    db = get_db()
    used = db.execute("SELECT 1 FROM appointments WHERE service_id = ? LIMIT 1", (sid,)).fetchone()
    if used:  # mantém o histórico: só desativa
        db.execute("UPDATE services SET active = 0 WHERE id = ?", (sid,))
    else:
        db.execute("DELETE FROM services WHERE id = ?", (sid,))
    db.commit()
    return jsonify(ok=True, deactivated=bool(used))


# ------------------------------------------------- disponibilidade e bloqueios

@api.get("/professionals/<int:pid>/availability")
@login_required
def get_availability(pid):
    require_manager(pid)
    rows = get_db().execute(
        "SELECT weekday, start_time, end_time FROM availability WHERE professional_id = ? ORDER BY weekday, start_time",
        (pid,),
    ).fetchall()
    return jsonify(rules=[dict(r) for r in rows])


@api.put("/professionals/<int:pid>/availability")
@login_required
def set_availability(pid):
    require_manager(pid)
    rules = body().get("rules")
    if not isinstance(rules, list):
        raise ApiError("Envie a lista de horários em 'rules'.")
    clean = []
    for rule in rules:
        weekday = rule.get("weekday") if isinstance(rule, dict) else None
        if weekday not in range(7):
            raise ApiError("Dia da semana inválido.")
        start, end = parse_time(rule.get("start_time")), parse_time(rule.get("end_time"))
        if minutes(start) >= minutes(end):
            raise ApiError("O início deve ser antes do fim em cada intervalo.")
        clean.append((pid, weekday, start, end))
    for wd in range(7):
        day_rules = sorted((r[2], r[3]) for r in clean if r[1] == wd)
        if any(minutes(b[0]) < minutes(a[1]) for a, b in zip(day_rules, day_rules[1:])):
            raise ApiError("Há intervalos sobrepostos no mesmo dia.")
    db = get_db()
    db.execute("DELETE FROM availability WHERE professional_id = ?", (pid,))
    db.executemany("INSERT INTO availability (professional_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)",
                   clean)
    db.commit()
    return get_availability(pid)


@api.get("/professionals/<int:pid>/blocks")
@login_required
def list_blocks(pid):
    require_manager(pid)
    rows = get_db().execute(
        "SELECT id, starts_at, ends_at, reason FROM blocks WHERE professional_id = ? AND ends_at > ? ORDER BY starts_at",
        (pid, fmt_dt(now_local())),
    ).fetchall()
    return jsonify(blocks=[dict(r) for r in rows])


@api.post("/professionals/<int:pid>/blocks")
@login_required
def create_block(pid):
    require_manager(pid)
    data = body()
    try:
        start, end = parse_dt(data.get("starts_at")), parse_dt(data.get("ends_at"))
    except (TypeError, ValueError):
        raise ApiError("Datas inválidas (use AAAA-MM-DDTHH:MM).")
    if start >= end:
        raise ApiError("O início do bloqueio deve ser antes do fim.")
    db = get_db()
    cur = db.execute("INSERT INTO blocks (professional_id, starts_at, ends_at, reason) VALUES (?, ?, ?, ?)",
                     (pid, fmt_dt(start), fmt_dt(end), text(data, "reason", max_len=200)))
    conflicts = db.execute(
        "SELECT COUNT(*) FROM appointments WHERE professional_id = ? AND status IN ('pendente', 'confirmado')"
        " AND starts_at < ? AND ends_at > ?", (pid, fmt_dt(end), fmt_dt(start)),
    ).fetchone()[0]
    db.commit()
    return jsonify(id=cur.lastrowid, conflicting_appointments=conflicts), 201


@api.delete("/blocks/<int:bid>")
@login_required
def delete_block(bid):
    db = get_db()
    row = db.execute("SELECT professional_id FROM blocks WHERE id = ?", (bid,)).fetchone()
    if row is None:
        raise ApiError("Bloqueio não encontrado.", 404)
    require_manager(row["professional_id"])
    db.execute("DELETE FROM blocks WHERE id = ?", (bid,))
    db.commit()
    return jsonify(ok=True)


# ------------------------------------------------------------- auxiliares

@api.get("/professionals/<int:pid>/assistants")
@login_required
def list_assistants(pid):
    require_owner(pid)
    rows = get_db().execute(
        "SELECT u.id, u.name, u.email, u.phone FROM assistants a JOIN users u ON u.id = a.assistant_id"
        " WHERE a.professional_id = ? ORDER BY u.name", (pid,),
    ).fetchall()
    return jsonify(assistants=[dict(r) for r in rows])


@api.post("/professionals/<int:pid>/assistants")
@login_required
def add_assistant(pid):
    require_owner(pid)
    email = text(body(), "email", required=True).lower()
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if user is None or user["role"] != "auxiliar":
        raise ApiError("Não há conta de auxiliar com este e-mail. Peça para a pessoa se cadastrar como auxiliar.", 404)
    db.execute("INSERT OR IGNORE INTO assistants (professional_id, assistant_id) VALUES (?, ?)", (pid, user["id"]))
    db.commit()
    return list_assistants(pid)


@api.delete("/professionals/<int:pid>/assistants/<int:aid>")
@login_required
def remove_assistant(pid, aid):
    require_owner(pid)
    db = get_db()
    db.execute("DELETE FROM assistants WHERE professional_id = ? AND assistant_id = ?", (pid, aid))
    db.commit()
    return jsonify(ok=True)


# ------------------------------------------------------------ agendamentos

@api.get("/professionals/<int:pid>/appointments")
@login_required
def professional_appointments(pid):
    require_manager(pid)
    sql, params = APPT_SELECT + " WHERE a.professional_id = ?", [pid]
    if request.args.get("from"):
        sql += " AND a.starts_at >= ?"
        params.append(parse_day(request.args["from"]).isoformat())
    if request.args.get("to"):
        sql += " AND a.starts_at < ?"
        params.append((parse_day(request.args["to"]) + timedelta(days=1)).isoformat())
    if request.args.get("status"):
        if request.args["status"] not in STATUSES:
            raise ApiError("Situação inválida.")
        sql += " AND a.status = ?"
        params.append(request.args["status"])
    rows = get_db().execute(sql + " ORDER BY a.starts_at LIMIT 1000", params).fetchall()
    return jsonify(appointments=[appt_dict(r) for r in rows])


@api.get("/professionals/<int:pid>/clients")
@login_required
def professional_clients(pid):
    """Clientes já atendidos, para sugerir ao agendar pelo profissional/auxiliar."""
    require_manager(pid)
    q = f"%{request.args.get('q', '').strip()}%"
    rows = get_db().execute(
        "SELECT client_name AS name, client_phone AS phone, client_email AS email, MAX(starts_at) AS last"
        " FROM appointments WHERE professional_id = ? AND (client_name LIKE ? OR client_phone LIKE ? OR client_email LIKE ?)"
        " GROUP BY lower(client_name), client_phone, client_email ORDER BY last DESC LIMIT 20",
        (pid, q, q, q),
    ).fetchall()
    return jsonify(clients=[dict(r) for r in rows])


@api.get("/appointments/mine")
@login_required
def my_appointments():
    rows = get_db().execute(APPT_SELECT + " WHERE a.client_id = ? ORDER BY a.starts_at DESC LIMIT 500",
                            (g.user["id"],)).fetchall()
    return jsonify(appointments=[appt_dict(r) for r in rows])


@api.post("/appointments")
@login_required
def create_appointment():
    data = body()
    try:
        pid = int(data.get("professional_id"))
    except (TypeError, ValueError):
        raise ApiError("Profissional inválido.")
    prof = get_professional(pid)
    service = get_service(data.get("service_id"), pid)
    if not service["active"]:
        raise ApiError("Este serviço não está disponível.")
    day = parse_day(data.get("date"))
    hhmm = parse_time(data.get("time"))
    start = datetime.combine(day, datetime.strptime(hhmm, "%H:%M").time())
    end = start + timedelta(minutes=service["duration_min"])
    db = get_db()
    manager = can_manage(g.user, pid)
    now = now_local()

    if manager:
        client_email = text(data, "client_email", max_len=200).lower()
        client = None
        if client_email:
            client = db.execute("SELECT * FROM users WHERE email = ?", (client_email,)).fetchone()
        client_id = client["id"] if client else None
        client_name = text(data, "client_name", max_len=120) or (client["name"] if client else "")
        if not client_name:
            raise ApiError("Informe o nome do cliente.")
        client_phone = text(data, "client_phone", max_len=40) or (client["phone"] if client else "")
        status = "confirmado"
        if data.get("fit_in"):  # encaixe: fora da grade de horários, mas sem conflito
            if start < now:
                raise ApiError("Não é possível agendar no passado.")
            if has_conflict(db, pid, start, end):
                raise ApiError("Já existe um agendamento ou bloqueio neste horário.", 409)
        elif hhmm not in compute_slots(db, prof, service["duration_min"], day, now, enforce_rules=False):
            raise ApiError("Horário indisponível. Para agendar fora da grade, marque como encaixe.", 409)
    else:
        client_id, client_name, client_phone, client_email = (
            g.user["id"], g.user["name"], g.user["phone"], g.user["email"])
        if hhmm not in compute_slots(db, prof, service["duration_min"], day, now, enforce_rules=True):
            raise ApiError("Este horário não está mais disponível. Escolha outro.", 409)
        status = "pendente" if prof["requires_confirmation"] else "confirmado"

    cur = db.execute(
        "INSERT INTO appointments (professional_id, service_id, client_id, client_name, client_phone, client_email,"
        " starts_at, ends_at, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (pid, service["id"], client_id, client_name, client_phone, client_email, fmt_dt(start), fmt_dt(end),
         status, text(data, "notes", max_len=1000), g.user["id"]),
    )
    db.commit()
    return jsonify(appointment=appt_dict(get_appointment(cur.lastrowid))), 201


@api.patch("/appointments/<int:aid>")
@login_required
def update_appointment(aid):
    appt = get_appointment(aid)
    data = body()
    db = get_db()
    pid = appt["professional_id"]
    manager = can_manage(g.user, pid)
    is_client = appt["client_id"] == g.user["id"]
    if not manager and not is_client:
        raise ApiError("Agendamento não encontrado.", 404)
    if appt["status"] == "cancelado":
        raise ApiError("Este agendamento já foi cancelado.")

    if not manager:
        if set(data) - {"status"} or data.get("status") != "cancelado":
            raise ApiError("Você só pode cancelar o seu agendamento.", 403)
        prof = get_professional(pid)
        limit = parse_dt(appt["starts_at"]) - timedelta(hours=prof["cancel_notice_hours"])
        if appt["status"] == "confirmado" and now_local() > limit:
            raise ApiError(f"Cancelamentos precisam de {prof['cancel_notice_hours']} h de antecedência. "
                           "Entre em contato com o profissional.", 403)

    updates = {}
    if "status" in data:
        if data["status"] not in STATUSES:
            raise ApiError("Situação inválida.")
        updates["status"] = data["status"]
    if "notes" in data:
        updates["notes"] = text(data, "notes", max_len=1000)
    if "date" in data or "time" in data:  # remarcar (só profissional/auxiliar)
        start = datetime.combine(parse_day(data.get("date")),
                                 datetime.strptime(parse_time(data.get("time")), "%H:%M").time())
        end = start + timedelta(minutes=appt["duration_min"])
        if has_conflict(db, pid, start, end, ignore_appointment=aid):
            raise ApiError("Já existe um agendamento ou bloqueio neste horário.", 409)
        updates.update(starts_at=fmt_dt(start), ends_at=fmt_dt(end))
    if updates:
        sets = ", ".join(f"{k} = ?" for k in updates)
        db.execute(f"UPDATE appointments SET {sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                   (*updates.values(), aid))
        db.commit()
    return jsonify(appointment=appt_dict(get_appointment(aid)))


# ------------------------------------------------------------------- app

def create_app(config=None):
    app = Flask(__name__, static_folder=None)
    app.config.update(
        DATABASE=os.environ.get("WELCOMELY_DB", os.path.join(BASE_DIR, "welcomely.db")),
        TIMEZONE=os.environ.get("WELCOMELY_TZ", "America/Sao_Paulo"),
        WEB_DIR=os.path.join(BASE_DIR, "..", "web"),
        JSON_SORT_KEYS=False,
    )
    if config:
        app.config.update(config)
    app.json.ensure_ascii = False
    init_db(app.config["DATABASE"])
    app.teardown_appcontext(close_db)
    app.register_blueprint(api)

    @app.after_request
    def cors(response):
        # O token vai no cabeçalho Authorization (sem cookies), então liberar a origem é seguro.
        if request.path.startswith("/api/"):
            response.headers["Access-Control-Allow-Origin"] = "*"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        return response

    @app.get("/")
    def index():
        response = send_from_directory(app.config["WEB_DIR"], "index.html")
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/<path:path>")
    def static_files(path):
        if path.startswith("api/"):
            return jsonify(error="Rota não encontrada."), 404
        response = send_from_directory(app.config["WEB_DIR"], path)
        # Sempre revalida (ETag): sem isso o navegador pode usar uma versão antiga do app.
        response.headers["Cache-Control"] = "no-cache"
        return response

    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    create_app().run(host=os.environ.get("HOST", "0.0.0.0"), port=port, debug=bool(os.environ.get("DEBUG")))
