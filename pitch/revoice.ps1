# Перезапись двух самых длинных фрагментов — общая длина была 96 сек при лимите 90.
# Сокращаю кадры 3 и 5 (были 16.1 и 17.8 сек), сохраняя смысл.
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice("Microsoft Zira Desktop")
$s.Rate = 0

$dir = "C:\Эксперимент\_build\verified-execution-agent\pitch\voice"

# Кадр 3: убрала перечисление четырёх слоёв — они видны на экране карточками
$s.SetOutputToWaveFile((Join-Path $dir "v3.wav"))
$s.Speak("V.E.A. is one call, made before signing. Verify returns allow or deny, plus a signed receipt anyone can check offline. Four layers, and the model layer can only add blocks, never remove them. Determinism always wins.")

# Кадр 5: убрала «not a self hosted stand in» — есть на экране
$s.SetOutputToWaveFile((Join-Path $dir "v5.wav"))
$s.Speak("This is not a demo. V.E.A. is listed and live on OKX dot AI, agent six three five eight, passed review July twenty seventh. Settlement runs through the official OKX facilitator on X Layer. Here is a real paid call on Base: verdict returned, receipt signed, money moved.")

$s.SetOutputToDefaultAudioDevice()
$s.Dispose()
Write-Host "перезаписаны кадры 3 и 5"
