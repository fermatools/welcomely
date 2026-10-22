"""Testes da API.  Uso (na pasta server):  python -m unittest discover -s tests"""
import os
import sys
import tempfile
import unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app  # noqa: E402


def next_weekday(weekday):
    """Próxima data (a partir de amanhã+1) que cai no dia da semana dado."""
    d = date.today() + timedelta(days=2)
    while d.weekday() != weekday:
        d += timedelta(days=1)
    return d


class ApiTest(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.app = create_app({"DATABASE": self.db_path, "TESTING": True})
        self.client = self.app.test_client()

    def tearDown(self):
        os.remove(self.db_path)

    def call(self, method, path, token=None, json=None, status=None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        res = self.client.open("/api" + path, method=method, json=json, headers=headers)
        if status is not None:
            self.assertEqual(res.status_code, status, res.get_json())
        return res.get_json()

    def register(self, name, role):
        data = self.call("POST", "/auth/register", json={
            "name": name, "email": f"{name.lower()}@ex.com", "password": "segredo1", "role": role}, status=201)
        return data["token"], data["user"]["id"]

    def test_fluxo_completo(self):
        prof_tok, prof_id = self.register("Ana", "profissional")
        cli_tok, _ = self.register("Carlos", "cliente")
        aux_tok, aux_id = self.register("Maria", "auxiliar")

        services = self.call("GET", f"/professionals/{prof_id}")["services"]
        self.assertEqual(len(services), 1)
        sid = services[0]["id"]
        day = next_weekday(0).isoformat()

        slots = self.call("GET", f"/professionals/{prof_id}/slots?date={day}&service_id={sid}")["slots"]
        self.assertEqual(slots[0], "09:00")
        self.assertIn("14:00", slots)
        self.assertNotIn("12:00", slots)

        # Cliente agenda: fica pendente (confirmação exigida por padrão)
        appt = self.call("POST", "/appointments", cli_tok, {
            "professional_id": prof_id, "service_id": sid, "date": day, "time": "09:00"}, status=201)["appointment"]
        self.assertEqual(appt["status"], "pendente")
        slots = self.call("GET", f"/professionals/{prof_id}/slots?date={day}&service_id={sid}")["slots"]
        self.assertNotIn("09:00", slots)

        # Mesmo horário de novo: conflito
        self.call("POST", "/appointments", cli_tok, {
            "professional_id": prof_id, "service_id": sid, "date": day, "time": "09:00"}, status=409)

        # Auxiliar ainda não vinculado
        self.call("GET", f"/professionals/{prof_id}/appointments", aux_tok, status=403)
        self.call("POST", f"/professionals/{prof_id}/assistants", prof_tok, {"email": "maria@ex.com"}, status=200)
        me = self.call("GET", "/me", aux_tok)
        self.assertEqual([p["id"] for p in me["manages"]], [prof_id])

        # Auxiliar confirma e agenda um cliente sem conta, inclusive encaixe
        self.call("PATCH", f"/appointments/{appt['id']}", aux_tok, {"status": "confirmado"}, status=200)
        self.call("POST", "/appointments", aux_tok, {
            "professional_id": prof_id, "service_id": sid, "date": day, "time": "09:30",
            "client_name": "José", "client_phone": "2199999"}, status=201)
        self.call("POST", "/appointments", aux_tok, {
            "professional_id": prof_id, "service_id": sid, "date": day, "time": "12:30",
            "client_name": "Rita"}, status=409)
        fit = self.call("POST", "/appointments", aux_tok, {
            "professional_id": prof_id, "service_id": sid, "date": day, "time": "12:30",
            "client_name": "Rita", "fit_in": True}, status=201)["appointment"]
        self.assertEqual(fit["status"], "confirmado")

        agenda = self.call("GET", f"/professionals/{prof_id}/appointments?from={day}&to={day}", prof_tok)
        self.assertEqual(len(agenda["appointments"]), 3)

        # Remarcar para horário ocupado falha; para livre funciona
        self.call("PATCH", f"/appointments/{fit['id']}", prof_tok, {"date": day, "time": "09:15"}, status=409)
        self.call("PATCH", f"/appointments/{fit['id']}", prof_tok, {"date": day, "time": "16:00"}, status=200)

        # Cliente vê e cancela o próprio; não pode confirmar
        mine = self.call("GET", "/appointments/mine", cli_tok)["appointments"]
        self.assertEqual(len(mine), 1)
        self.call("PATCH", f"/appointments/{appt['id']}", cli_tok, {"status": "confirmado"}, status=403)
        self.call("PATCH", f"/appointments/{appt['id']}", cli_tok, {"status": "cancelado"}, status=200)
        slots = self.call("GET", f"/professionals/{prof_id}/slots?date={day}&service_id={sid}")["slots"]
        self.assertIn("09:00", slots)

    def test_bloqueio_e_disponibilidade(self):
        prof_tok, prof_id = self.register("Joao", "profissional")
        sid = self.call("GET", f"/professionals/{prof_id}")["services"][0]["id"]
        day = next_weekday(5)  # sábado: sem horários por padrão
        url = f"/professionals/{prof_id}/slots?date={day}&service_id={sid}"
        self.assertEqual(self.call("GET", url)["slots"], [])

        self.call("PUT", f"/professionals/{prof_id}/availability", prof_tok, {"rules": [
            {"weekday": 5, "start_time": "08:00", "end_time": "10:00"}]}, status=200)
        self.assertEqual(self.call("GET", url)["slots"], ["08:00", "08:30", "09:00", "09:30"])

        self.call("PUT", f"/professionals/{prof_id}/availability", prof_tok, {"rules": [
            {"weekday": 5, "start_time": "08:00", "end_time": "10:00"},
            {"weekday": 5, "start_time": "09:00", "end_time": "11:00"}]}, status=400)

        self.call("POST", f"/professionals/{prof_id}/blocks", prof_tok, {
            "starts_at": f"{day}T08:30", "ends_at": f"{day}T09:30", "reason": "Missa"}, status=201)
        self.assertEqual(self.call("GET", url)["slots"], ["08:00", "09:30"])

    def test_permissoes(self):
        _, prof_id = self.register("Ana", "profissional")
        other_tok, _ = self.register("Beto", "profissional")
        cli_tok, _ = self.register("Carlos", "cliente")
        self.call("PUT", f"/professionals/{prof_id}/profile", other_tok, {"title": "x"}, status=403)
        self.call("GET", f"/professionals/{prof_id}/appointments", cli_tok, status=403)
        self.call("POST", f"/professionals/{prof_id}/assistants", other_tok, {"email": "carlos@ex.com"}, status=403)
        self.call("GET", "/me", status=401)
        self.call("POST", "/auth/login", json={"email": "ana@ex.com", "password": "errada"}, status=401)


if __name__ == "__main__":
    unittest.main()
