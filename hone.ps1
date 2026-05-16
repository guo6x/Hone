#!/usr/bin/env pwsh
# Hone CLI entry script for Windows PowerShell
# Set API key via: $env:DEEPSEEK_API_KEY="sk-..." in your profile
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $scriptDir "dist\cli.js"
$bun = "$env:USERPROFILE\.bun\bin\bun.exe"

# God Mode: skip all permission prompts (set to 0 to disable)
if (-not (Test-Path Env:HONE_GOD_MODE)) { $env:HONE_GOD_MODE = "1" }

# Remove Anthropic-specific env vars if they leak
Remove-Item Env:USER_TYPE -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

& $bun $cli @args
