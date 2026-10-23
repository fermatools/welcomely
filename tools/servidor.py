"""Servidor local do app web para testes: serve web/ em http://localhost:5000 sem cache
(o http.server padrão deixa o navegador reaproveitar JS/CSS antigos depois de uma edição).

Uso:  python tools/servidor.py [porta]
"""
import functools
import http.server
import os
import sys

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".webmanifest": "application/manifest+json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    handler = functools.partial(NoCacheHandler, directory=WEB)
    print(f"Welcomely em http://localhost:{port}  (Ctrl+C para parar)")
    http.server.ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()
