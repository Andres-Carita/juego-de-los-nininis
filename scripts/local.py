# Ajudante local (Ollama, grátis). Uso por qualquer agente:
#   python scripts/local.py "pedido"                 -> modelo padrão (qwen2.5-coder:7b)
#   python scripts/local.py -m phi4-mini "pedido"    -> outro modelo do Ollama
#   python scripts/local.py --json "pedido"          -> força resposta em JSON
# Bom para: rascunhos, variações, traduções curtas, listas, ideias. Sempre conferir a saída.
import json, sys, urllib.request
args = sys.argv[1:]; model = 'qwen2.5-coder:7b'; fmt = None
if args[:1] == ['-m']: model = args[1]; args = args[2:]
if args[:1] == ['--json']: fmt = 'json'; args = args[1:]
prompt = ' '.join(args) or sys.stdin.read()
body = {'model': model, 'prompt': prompt, 'stream': False, 'options': {'temperature': 0.6, 'num_predict': 1500}}
if fmt: body['format'] = fmt
r = urllib.request.urlopen(urllib.request.Request('http://localhost:11434/api/generate', json.dumps(body).encode(), {'Content-Type': 'application/json'}), timeout=900)
sys.stdout.reconfigure(encoding='utf-8'); print(json.loads(r.read())['response'])
