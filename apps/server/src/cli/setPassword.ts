// 비밀번호 정하기/바꾸기 — 터미널에서만 한다.
//   corepack pnpm --filter @mongolive/server set-password
//
// 웹에서 '처음 온 사람이 정하는' 방식을 쓰지 않는 이유: 서버가 외부에 열린 상태면
// 낯선 사람이 먼저 들어와 비밀번호를 정해 버릴 수 있다. 터미널은 이 컴퓨터에 들어올 수 있는 사람만 쓴다.
//
// 바꾸면 쿠키 서명 키도 새로 만들어져 다른 기기의 로그인이 모두 풀린다.
import { createInterface } from 'node:readline';
import { authFilePath } from '../paths';
import { createAuthData, loadAuthData, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, writeAuthFile } from '../authFile';

// 터미널이면 입력을 화면에 보이지 않게 받는다(raw 모드: 글자 하나씩 직접 받고 다시 찍지 않음)
const askHidden = (prompt: string): Promise<string> =>
  new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(input);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(false);
          stdout.write('\n취소했습니다.\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1);
        else input += ch;
      }
    };
    stdin.on('data', onData);
  });

// 파이프로 넣을 때(스크립트, 테스트): 한 줄씩 읽는다
const pipedLines = (): (() => Promise<string>) => {
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl.on('close', () => waiters.splice(0).forEach((w) => w('')));
  return () => new Promise((resolve) => (lines.length ? resolve(lines.shift()!) : waiters.push(resolve)));
};

const main = async () => {
  const path = authFilePath();
  const nextLine = process.stdin.isTTY ? null : pipedLines();
  const ask = (prompt: string): Promise<string> => {
    if (!nextLine) return askHidden(prompt);
    process.stdout.write(`${prompt}\n`);
    return nextLine();
  };

  const existed = loadAuthData(path) !== null;
  console.log(existed ? `비밀번호를 바꿉니다 (${path})` : `비밀번호를 정합니다 (${path})`);

  const password = await ask(`새 비밀번호 (${MIN_PASSWORD_LENGTH}자 이상): `);
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error(`${MAX_PASSWORD_LENGTH}자 이하여야 합니다.`);
  const again = await ask('한 번 더: ');
  if (again !== password) throw new Error('두 번 입력한 값이 다릅니다.');

  await writeAuthFile(path, await createAuthData(password));
  console.log(existed ? '바꿨습니다. 다른 기기의 로그인은 모두 풀렸습니다.' : '정했습니다. 이제 서버를 켜면 됩니다.');
  process.exit(0);
};

main().catch((e: Error) => {
  console.error(`실패: ${e.message}`);
  process.exit(1);
});
