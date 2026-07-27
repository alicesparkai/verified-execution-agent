/**
 * signMsg.ts — personalSign сообщения приватным ключом ретранслятора.
 *
 * ЗАЧЕМ: портал разработчика OKX требует «Connect wallet» → «Verify address»: доказать
 * подписью, что адрес мой. Расширения кошелька в VPN-профиле Chrome нет, и ставить его я не
 * хочу — это софт с правом читать все страницы. Но приватный ключ ретранслятора лежит
 * локально, значит подписать я МОГУ по-настоящему; не хватает только посредника-расширения.
 *
 * ЧЕСТНОСТЬ: это не подделка владения. Адрес мой, подпись настоящая, проверяется обычным
 * ecrecover. Подменяется только ТРАНСПОРТ (расширение → мой провайдер) — ровно как с
 * вещателем: меняется точка отправки, а не сам факт.
 *
 * Запуск: npx tsx src/tools/signMsg.ts "<сообщение>"
 * В stdout уходит ТОЛЬКО подпись; адрес — в stderr для сверки глазами. Ключ не печатается.
 */
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

const msg = process.argv[2];
if (!msg) {
  console.error('нужно сообщение: npx tsx src/tools/signMsg.ts "<текст>"');
  process.exit(2);
}

const SECRETS = 'C:/Эксперимент/perception/_secrets_vea_relayer.json';
const pk = (JSON.parse(readFileSync(SECRETS, 'utf8')) as { privateKey?: string }).privateKey;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error('в файле секретов нет валидного privateKey');
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);

// personal_sign передаёт сообщение либо текстом, либо hex-строкой (так делает портал OKX).
// Hex подписываем как СЫРЫЕ БАЙТЫ: декодировать в текст и подписать строку — тот же результат
// только если байты валидный UTF-8. Raw надёжнее и совпадает с тем, что проверит ecrecover.
const isHex = /^0x[0-9a-fA-F]*$/.test(msg) && msg.length > 2 && msg.length % 2 === 0;
const signature = await account.signMessage(
  isHex ? { message: { raw: msg as `0x${string}` } } : { message: msg },
);
console.error('адрес:', account.address, isHex ? '(hex → raw bytes)' : '(текст)');
console.log(signature);
