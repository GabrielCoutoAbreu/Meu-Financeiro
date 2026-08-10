$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$target = Join-Path $PSScriptRoot 'Start-MeuFinanceiro.cmd'
$shortcutPath = Join-Path $desktop 'Meu Financeiro.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'Controle financeiro pessoal'
$shortcut.Save()
Write-Host "Atalho criado em: $shortcutPath"
