"""Cálculo dos horários livres de um profissional num dia."""
from datetime import datetime, time, timedelta

FMT = "%Y-%m-%dT%H:%M"
ACTIVE_STATUSES = ("pendente", "confirmado")


def parse_dt(value):
    return datetime.strptime(value, FMT)


def fmt_dt(value):
    return value.strftime(FMT)


def minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def busy_intervals(conn, professional_id, start, end, ignore_appointment=None):
    """Agendamentos ativos e bloqueios que se sobrepõem a [start, end)."""
    rows = conn.execute(
        "SELECT starts_at, ends_at FROM appointments"
        " WHERE professional_id = ? AND status IN (?, ?) AND starts_at < ? AND ends_at > ? AND id IS NOT ?",
        (professional_id, *ACTIVE_STATUSES, fmt_dt(end), fmt_dt(start), ignore_appointment),
    ).fetchall()
    rows += conn.execute(
        "SELECT starts_at, ends_at FROM blocks WHERE professional_id = ? AND starts_at < ? AND ends_at > ?",
        (professional_id, fmt_dt(end), fmt_dt(start)),
    ).fetchall()
    return [(parse_dt(r["starts_at"]), parse_dt(r["ends_at"])) for r in rows]


def has_conflict(conn, professional_id, start, end, ignore_appointment=None):
    return bool(busy_intervals(conn, professional_id, start, end, ignore_appointment))


def compute_slots(conn, prof, duration_min, day, now, enforce_rules=True):
    """Lista de horários "HH:MM" livres em `day` para um atendimento de `duration_min`.

    `enforce_rules` aplica antecedência mínima e janela máxima de agendamento
    (desligado quando quem agenda é o profissional ou o auxiliar).
    """
    if day < now.date():
        return []
    if enforce_rules and day > now.date() + timedelta(days=prof["max_days_ahead"]):
        return []

    day_start = datetime.combine(day, time(0))
    busy = busy_intervals(conn, prof["user_id"], day_start, day_start + timedelta(days=1))
    earliest = now + timedelta(hours=prof["min_notice_hours"]) if enforce_rules else now
    duration = timedelta(minutes=duration_min)
    step = timedelta(minutes=prof["slot_interval_min"] or duration_min)

    rules = conn.execute(
        "SELECT start_time, end_time FROM availability WHERE professional_id = ? AND weekday = ?",
        (prof["user_id"], day.weekday()),
    ).fetchall()
    slots = set()
    for rule in rules:
        t = day_start + timedelta(minutes=minutes(rule["start_time"]))
        limit = day_start + timedelta(minutes=minutes(rule["end_time"]))
        while t + duration <= limit:
            if t >= earliest and not any(t < b_end and t + duration > b_start for b_start, b_end in busy):
                slots.add(t.strftime("%H:%M"))
            t += step
    return sorted(slots)
