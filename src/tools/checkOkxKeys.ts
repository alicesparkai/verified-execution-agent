/**
 * checkOkxKeys.ts — проверить, что ключи портала OKX рабочие, ДО деплоя.
 *
 * ЗАЧЕМ: деплой + подача листинга — дорогая петля (минуты + попытка из ограниченного числа).
 * Один вызов getSupported() отвечает на главный вопрос: принимает ли их фасилитатор мои
 * учётные данные и знает ли он сеть, которую я собираюсь объявлять в challenge.
 *
 * ⚠️ Из Казахстана хост может быть закрыт по региону — тогда провал здесь НИЧЕГО не говорит
 * о работоспособности на Render (он в США). Отличать сетевой отказ от отказа авторизации.
 */
import { readFileSync } from 'node:fs';
import { OKXFacilitatorClient } from '@okxweb3/x402-core';

const s = JSON.parse(readFileSync('C:/Эксперимент/perception/_secrets_okx_api.json', 'utf8'));
if (!s.apiKey || !s.secretKey || !s.passphrase) {
  console.error('в файле секретов нет полного набора ключей');
  process.exit(1);
}

const client = new OKXFacilitatorClient({
  apiKey: s.apiKey,
  secretKey: s.secretKey,
  passphrase: s.passphrase,
});

try {
  const supported = await client.getSupported();
  console.log('✅ ключи ПРИНЯТЫ облачным фасилитатором OKX');
  const kinds = (supported as any)?.kinds ?? supported;
  console.log('поддерживаемые схемы/сети:', JSON.stringify(kinds).slice(0, 600));
  const has196 = JSON.stringify(supported).includes('eip155:196');
  console.log(has196 ? '✅ сеть eip155:196 в списке' : '⚠️ eip155:196 в ответе НЕ найдена — проверить');
} catch (e: any) {
  const msg = String(e?.message ?? e);
  console.error('⛔ не удалось:', msg.slice(0, 300));
  if (/fetch failed|ENOTFOUND|ECONNRESET|timeout|socket/i.test(msg)) {
    console.error('   Похоже на СЕТЕВОЙ отказ (регион), а не на отказ ключей.');
    console.error('   Это НЕ значит, что ключи плохие — проверять с Render.');
  } else if (/401|403|unauthorized|invalid/i.test(msg)) {
    console.error('   Похоже на отказ АВТОРИЗАЦИИ — ключи/passphrase неверны.');
  }
  process.exit(1);
}
