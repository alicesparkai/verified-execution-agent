# Озвучка питча VEA. Голос Microsoft Zira (en-US).
#
# ⚠ ТЕМП И ДЛИНА — ЭТО ОГРАНИЧЕНИЕ, А НЕ ВКУС. Лимит площадки 90 секунд.
# Версия с Rate=-1 («чуть медленнее, для ясности») дала 136 секунд — такое видео
# просто не приняли бы. Длину надо считать ДО сборки, а не после: поэтому текст
# здесь подрезан под темп Rate=0, а скрипт сам печатает суммарную длительность.
#
# Каждый кадр — отдельный wav: длительность кадра в видео = длительности его фразы.
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice("Microsoft Zira Desktop")
# Rate=1, а не 0: при нуле подрезанный текст всё равно дал 105 сек против лимита 90.
# Замер живым файлом, а не прикидкой по размеру, — байтовая формула здесь врёт
# (частота дискретизации у синтезатора не та, что кажется).
$s.Rate = 1

$dir = "C:\Эксперимент\_build\verified-execution-agent\pitch\voice"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$lines = @(
  "VEA. The safety layer the agent economy is missing. A pre-flight firewall any agent calls before it signs.",
  "On OKX dot AI, agents hold spend authority. The moment an agent can pay, it can be drained: a malicious counterparty, a poisoned prompt, or its own misreading of calldata. Nothing stands between intention and the chain.",
  "VEA is one call, made before signing. Verify returns allow or deny, plus a receipt anyone can check offline. Four layers, and the model layer can only add blocks, never remove them. Determinism wins.",
  "Here is the catch. The agent says: approve a small U.S.D.C. spend for a swap. The bytes say: approve, unlimited, forever. That is how wallets get drained. V.E.A. decodes the bytes and refuses, stating the reason.",
  "This is not a demo. V.E.A. is listed and live on OKX dot AI, agent six three five eight. Settlement runs through the official OKX facilitator. Here is a real paid call on Base: money moved, receipt signed.",
  "V.E.A. is non custodial by design. It holds no keys and never executes. A firewall that could sign would itself be the biggest risk.",
  "Every other service here is a potential caller. V.E.A. sits in their request path. The more agents transact, the more it is needed. Built end to end by Alice Spark, an autonomous A.I. agent."
)

for ($i = 0; $i -lt $lines.Count; $i++) {
  $f = Join-Path $dir ("v{0}.wav" -f ($i + 1))
  $s.SetOutputToWaveFile($f)
  $s.Speak($lines[$i])
}
$s.SetOutputToDefaultAudioDevice()
$s.Dispose()

# Суммарная длительность — ГЛАВНОЕ число, печатаем сразу.
$total = 0.0
Get-ChildItem $dir -Filter *.wav | Sort-Object Name | ForEach-Object {
  $sec = ($_.Length - 44) / (16000.0 * 2)
  $total += $sec
  Write-Host ("{0}  {1:N1} sec" -f $_.Name, $sec)
}
Write-Host ("ITOGO {0:N1} sec (limit 90)" -f $total)
