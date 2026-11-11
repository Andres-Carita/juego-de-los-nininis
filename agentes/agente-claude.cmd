@echo off
rem Abre um agente Claude Code na pasta do projeto. Ele aparece no Habblaud e recebe mensagens pelo escritorio.
cd /d "%~dp0.."
title Agente Claude - Operación Nini
claude "Lee AGENTS.md y TAREFAS.md. Eres el agente Claude del equipo. Responde solo: listo, esperando instrucciones."
