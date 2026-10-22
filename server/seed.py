"""Cria contas de demonstração (apaga o banco atual se for passado --reset).

Uso:  python seed.py [--reset]

Contas criadas (senha de todas: demo123):
  ana@demo.welcomely      profissional (psicóloga)
  joao@demo.welcomely     profissional (padre)
  maria@demo.welcomely    auxiliar (secretária dos dois)
  carlos@demo.welcomely   cliente
"""
import os
import sys
from datetime import date, timedelta

from werkzeug.security import generate_password_hash

from app import add_defaults_for_professional, create_app
from db import get_db

PASSWORD = "demo123"


def main():
    app = create_app()
    if "--reset" in sys.argv and os.path.exists(app.config["DATABASE"]):
        os.remove(app.config["DATABASE"])
        app = create_app()
    with app.app_context():
        db = get_db()
        if db.execute("SELECT 1 FROM users WHERE email LIKE '%@demo.welcomely'").fetchone():
            print("Dados de demonstração já existem (use --reset para recriar).")
            return

        def user(name, email, role, phone=""):
            return db.execute(
                "INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)",
                (name, email, phone, generate_password_hash(PASSWORD), role),
            ).lastrowid

        ana = user("Dra. Ana Souza", "ana@demo.welcomely", "profissional", "(21) 98888-0001")
        add_defaults_for_professional(db, ana)
        db.execute("UPDATE professionals SET title = 'Psicóloga clínica', location = 'Niterói — Icaraí',"
                   " bio = 'Atendimento de adultos e adolescentes. Terapia cognitivo-comportamental.',"
                   " slot_interval_min = 60 WHERE user_id = ?", (ana,))
        db.execute("UPDATE services SET name = 'Sessão de terapia', duration_min = 50 WHERE professional_id = ?", (ana,))
        db.execute("INSERT INTO services (professional_id, name, description, duration_min) VALUES"
                   " (?, 'Primeira consulta', 'Entrevista inicial', 60)", (ana,))

        joao = user("Pe. João Lima", "joao@demo.welcomely", "profissional")
        add_defaults_for_professional(db, joao)
        db.execute("UPDATE professionals SET title = 'Pároco', location = 'Paróquia São José',"
                   " bio = 'Atendimento pastoral, confissões e orientação espiritual.', requires_confirmation = 0"
                   " WHERE user_id = ?", (joao,))
        db.execute("UPDATE services SET name = 'Atendimento pastoral', duration_min = 30 WHERE professional_id = ?", (joao,))
        db.execute("INSERT INTO services (professional_id, name, duration_min) VALUES (?, 'Confissão', 15)", (joao,))
        db.execute("INSERT INTO services (professional_id, name, description, duration_min) VALUES"
                   " (?, 'Preparação para batismo', 'Conversa com pais e padrinhos', 60)", (joao,))

        maria = user("Maria Oliveira", "maria@demo.welcomely", "auxiliar", "(21) 97777-0003")
        db.executemany("INSERT INTO assistants (professional_id, assistant_id) VALUES (?, ?)", [(ana, maria), (joao, maria)])

        carlos = user("Carlos Pereira", "carlos@demo.welcomely", "cliente", "(21) 96666-0004")

        # Alguns agendamentos nos próximos dias úteis
        d = date.today() + timedelta(days=1)
        while d.weekday() >= 5:
            d += timedelta(days=1)
        sid_ana = db.execute("SELECT id FROM services WHERE professional_id = ? ORDER BY id", (ana,)).fetchone()[0]
        sid_joao = db.execute("SELECT id FROM services WHERE professional_id = ? ORDER BY id", (joao,)).fetchone()[0]
        appts = [
            (ana, sid_ana, carlos, "Carlos Pereira", "(21) 96666-0004", "carlos@demo.welcomely", "09:00", "09:50", "pendente"),
            (ana, sid_ana, None, "Beatriz Santos", "(21) 95555-1234", "", "10:00", "10:50", "confirmado"),
            (ana, sid_ana, None, "Rafael Costa", "", "", "14:00", "14:50", "confirmado"),
            (joao, sid_joao, carlos, "Carlos Pereira", "(21) 96666-0004", "carlos@demo.welcomely", "15:00", "15:30", "confirmado"),
            (joao, sid_joao, None, "Família Almeida", "(21) 94444-5678", "", "16:00", "16:30", "confirmado"),
        ]
        for pid, sid, cid, name, phone, email, start, end, status in appts:
            db.execute(
                "INSERT INTO appointments (professional_id, service_id, client_id, client_name, client_phone,"
                " client_email, starts_at, ends_at, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (pid, sid, cid, name, phone, email, f"{d}T{start}", f"{d}T{end}", status, maria),
            )
        db.commit()
        print(f"Dados de demonstração criados. Senha de todas as contas: {PASSWORD}")


if __name__ == "__main__":
    main()
