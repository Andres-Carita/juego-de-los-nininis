# Regras do projeto — Operación Nini (para todas as IAs)

Este arquivo vale para Claude, GPT/Codex, Gemini e modelos locais (Ollama).

## O projeto
- Jogo de tiro 3D no navegador, com humor de escritório e fotos de amigos como personagens. Todo texto do jogo em **espanhol**.
- Arquivo principal: `index.html` (um único HTML grande, Three.js r128, com fim de linha CRLF; o código fica dentro de uma IIFE). Servidor: `online/worker.js` (Cloudflare Worker com salas online, classificação e buzão de fotos).
- Publicado em https://operacion-nini.ninidam.workers.dev (conta Cloudflare juegoninidam1@). GitHub público: `Andres-Carita/juego-de-los-nininis`, branch `claude/relaxed-einstein-6wkscc`. Três pessoas editam o mesmo `index.html` (Heverton, um amigo com o Claude dele, Bilal-Ayadi).

## Regras do jogo Nini
- **Sempre `git pull --ff-only` antes de mexer**, de novo antes de enviar, e enviar ao terminar. Nunca `git push --force`.
- **Nunca publicar** (`wrangler deploy`) sem o usuário mandar.
- Testar numa cópia temporária fora do projeto, com o gancho `window.__ev=function(c){return eval(c);};` antes do `})();` final; esse gancho nunca entra no projeto (conferir com grep antes de cada commit).
- Arquivos que não são do jogo precisam estar no `.assetsignore`, senão vão parar no site.

## Regras
- Fale com o usuário em **português do Brasil**.
- Nunca colocar chaves, senhas ou tokens em arquivos ou no chat.
- Nunca publicar (deploy) sem o usuário mandar.
- Uma IA por arquivo de cada vez: antes de mexer, marque a tarefa em `TAREFAS.md` com o seu nome.
- Quem gera conteúdo não é quem aprova: o que uma IA gera é revisado por outra e conferido pelo Claude antes de entrar no projeto.

## Papéis
| Agente | Onde roda | Papel |
|---|---|---|
| **Claude** (Claude Code) | Habblaud — `agentes/agente-claude.cmd` | Coordena, escreve o código, testa, publica quando o usuário manda |
| **GPT** (Codex) | Habblaud — `agentes/agente-gpt.cmd` | Revisa código e textos, segunda opinião, imagens |
| **Local** (Ollama) | Ajudante, chamado por qualquer agente: `python scripts/local.py "pedido"` | Rascunhos em volume, variações, listas (grátis, no PC). Sempre conferir |
| **Gemini** | Ajudante: `gemini --skip-trust -p "pedido"` | Pesquisa e revisão quando a cota grátis deixar |

O usuário escolhe quem faz cada tarefa escrevendo o nome do agente em `TAREFAS.md` (ou mandando mensagem pelo Habblaud).

## Como trabalhar em equipe
1. **Ao começar**, leia `TAREFAS.md`. Faça só as tarefas com o seu nome (`Claude`, `GPT`) ou sem dono — e ponha o seu nome antes de começar.
2. **Ao terminar**, marque `[x]`, escreva o resultado em uma linha e faça commit (`git add` só dos arquivos que você mexeu).
3. **Pedir ajuda a outro agente**: escreva na seção "Pedidos de ajuda" do `TAREFAS.md`: `- [ ] @GPT: revisar X — de Claude`. O outro agente responde ali mesmo.
4. **Pedir ajuda ao modelo local** (grátis): use `scripts/local.py` para rascunhos; nunca entregue a saída sem conferir.
5. **Nunca** mexa num arquivo que outra tarefa em andamento está usando.
