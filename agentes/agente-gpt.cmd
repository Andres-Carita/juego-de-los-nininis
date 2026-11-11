@echo off
rem Abre o agente GPT (Codex) na pasta do projeto, sem pedir aprovacao: edita e roda comandos so dentro desta pasta, sem internet.
rem Uso: agente-gpt.cmd            -> espera instrucoes pelo Habblaud
rem      agente-gpt.cmd arquivo.md -> ja comeca fazendo a tarefa descrita no arquivo
cd /d "%~dp0.."
title Agente GPT - Operación Nini
if "%~1"=="" (
  codex -a never -s workspace-write "Lee AGENTS.md y TAREFAS.md. Eres el agente GPT del equipo. Responde solo: listo, esperando instrucciones."
) else (
  codex -a never -s workspace-write "Lee AGENTS.md y TAREFAS.md. Eres el agente GPT del equipo. Haz la tarea descrita en %~1."
)
