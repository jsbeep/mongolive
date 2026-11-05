# 배포와 보안

mongolive를 내 컴퓨터(또는 라즈베리파이 같은 서버)에서 띄우고, 필요하면 다른 기기에서 접속하는 방법

## 한눈에

| 어디서 접속하나 | 방법 | 준비물 |
|---|---|---|
| 이 기기에서만 | [A. 기본 설정 그대로](#a-이-기기에서만-기본) | 없음 |
| 다른 기기에서도 (도메인 있음) | [B. 앞단 프록시가 HTTPS를 맡음](#b-앞단-프록시가-https를-맡음) | 도메인 + Caddy/nginx, 또는 Tailscale |
| 다른 기기에서도 (생 IP:포트) | [C. 서버가 직접 HTTPS](#c-서버가-직접-https) | 인증서 파일 |

어느 방법이든 **비밀번호 로그인은 항상 켜져 있다.** 이 기기에서 접속해도 로그인한다.
외부에 열면서 HTTPS가 없으면 서버가 켜지지 않는다(비밀번호가 평문으로 오가므로).

## 공통: 처음 한 번

```bash
corepack pnpm install

# 1. MongoDB 주소 — replica set이어야 실시간 반영이 동작한다
cp apps/server/.env.example apps/server/.env
#    apps/server/.env 의 MONGODB_URI 를 채운다

# 2. 비밀번호 — 화면에 보이지 않게 입력받아 해시만 ~/.mongolive/auth.json(권한 600)에 저장한다
corepack pnpm set-password

# 3. 웹 화면 빌드 → 서버가 화면까지 내준다(포트 하나)
corepack pnpm build:web:remote

# 4. 실행
corepack pnpm start
```

- 비밀번호를 잊었거나 바꾸고 싶으면 `set-password`를 다시 실행한다. **바꾸면 모든 기기에서 로그아웃된다.**
- MongoDB에는 아무것도 저장하지 않는다. 앱이 쓰는 파일은 전부 `~/.mongolive/`에 있다.

## A. 이 기기에서만 (기본)

`.env`의 `HOST=127.0.0.1`(기본값) 그대로 두면 이 기기 밖에서는 접속할 수 없다. 요청이 기기 밖으로 나가지 않으므로 HTTPS도 필요 없다.

`http://127.0.0.1:31501`

## B. 앞단 프록시가 HTTPS를 맡음

프록시(Caddy, nginx, Tailscale serve 등)가 인증서를 처리하고, mongolive는 이 기기 안에서 HTTP로 돈다.

```bash
# apps/server/.env
HOST=127.0.0.1        # 프록시만 붙을 수 있게
TRUST_PROXY=true      # 프록시가 붙여 주는 X-Forwarded-* 헤더를 믿는다
```

`TRUST_PROXY`가 필요한 이유: 프록시 뒤에서는 모든 요청이 "127.0.0.1에서 온 HTTP"로 보인다. 프록시가 헤더로 알려 주는 원래 정보를 써야

- 쿠키에 `Secure`(HTTPS에서만 보냄)가 붙고,
- 로그인 잠금이 실제 접속자 IP 기준으로 걸리고,
- 교차 사이트 요청 검사(Origin)가 원래 주소 기준으로 동작한다.

이 헤더는 **이 기기 안에서 온 연결일 때만** 믿는다. 밖에서 같은 헤더를 지어내 보내도 무시된다.

### Caddy (도메인이 있으면 가장 간단 — Let's Encrypt 인증서를 알아서 받고 갱신한다)

```caddy
mongo.example.com {
    reverse_proxy 127.0.0.1:31501
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name mongo.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:31501;
        # 실시간 반영(WebSocket)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # 원래 요청 정보 — nginx는 기본 설정에서 Host를 바꿔 넘긴다
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Tailscale

도메인 없이 내 기기들끼리만 쓸 때. `tailscale serve`로 `https://<기기이름>.<tailnet>.ts.net` 주소에 HTTPS가 자동으로 붙고, 인터넷에는 드러나지 않는다.
설정 후 로그인해 보고, 브라우저 개발자 도구에서 `mongolive_session` 쿠키에 `Secure`가 붙었는지 확인한다.

## C. 서버가 직접 HTTPS

프록시 없이 `https://<IP>:31501`로 바로 접속할 때.

```bash
# apps/server/.env
HOST=0.0.0.0
TLS_CERT=/home/me/.mongolive/tls/cert.pem
TLS_KEY=/home/me/.mongolive/tls/key.pem
```

- 인증서 파일이 바뀌면(갱신) 서버를 다시 켜지 않아도 1분 안에 새 인증서를 쓴다.
- 인증서에 적힌 이름(IP 또는 도메인)으로 접속해야 한다. IP가 바뀌면 인증서도 다시 만든다.

### 인증서 구하기

브라우저는 미리 믿는 **인증기관(CA)** 목록을 갖고 있고, 그 기관이 서명한 인증서만 믿는다.

| 방법 | 브라우저 경고 | 접속하는 기기에 할 일 |
|---|---|---|
| 공인 인증기관(Let's Encrypt) | 없음 | 없음 — 대신 도메인이 필요하다(→ B의 Caddy가 더 쉽다) |
| [mkcert](https://github.com/FiloSottile/mkcert) | 없음 | 루트 인증서를 한 번 설치 |
| 아래의 테스트용 인증서 | 없음 | 루트 인증서를 한 번 설치 |
| 자체 서명(스스로 도장) | 매번 뜸 | — 권하지 않는다. 공격자의 가짜 인증서와 구별할 수 없어 경고를 무시하는 습관이 든다 |

### 테스트용 인증서 만들기 (openssl, 추가 설치 없음)

mkcert처럼 나만의 인증기관을 만들되, 두 가지를 더 해서 기기에 설치해도 위험이 적게 한다.

1. **이름 제한** — 이 인증기관은 아래 적은 이름으로만 인증서를 발급할 수 있다(`google.com` 같은 가짜 인증서 불가).
2. **비밀키 파기** — 서버 인증서를 하나 발급한 뒤 인증기관의 비밀키를 지운다. 이후로는 아무 인증서도 발급할 수 없다.

대신 만료(1년)되거나 IP가 바뀌면 처음부터 다시 만들고 기기에도 다시 설치해야 한다. 오래 쓸 거면 mkcert나 B를 쓴다.

```bash
# ── 바꿔 넣을 값 ─────────────────────────────────────
NAMES="IP:203.0.113.10,IP:127.0.0.1,DNS:localhost"   # 접속할 주소들 (공인 IP, 공유기 안 IP 등)
CA_NAME="MongoLive Test CA (203.0.113.10)"
# ─────────────────────────────────────────────────────
D=~/.mongolive/tls
TMP=$(mktemp -d)
mkdir -p "$D" && chmod 700 "$D"

# 이름 제한 목록: IP는 "IP:주소/255.255.255.255", DNS는 그대로
CONSTRAINTS=$(echo "$NAMES" | tr ',' '\n' | sed -E 's#^IP:(.*)$#permitted;IP:\1/255.255.255.255#; s#^DNS:(.*)$#permitted;DNS:\1#' | paste -sd,)

# 1. 인증기관 — 도장 찍는 용도만, 하위 기관 불가, 위 이름으로만 발급 가능
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "$TMP/ca-key.pem" -out "$D/mongolive-test-ca.crt" -days 365 \
  -subj "/CN=$CA_NAME" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "nameConstraints=critical,$CONSTRAINTS"

# 2. 서버 비밀키 + 발급 신청서
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "$D/key.pem" -out "$TMP/leaf.csr" -subj "/CN=mongolive"

# 3. 인증기관이 도장 → 서버 인증서
printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' "$NAMES" > "$TMP/leaf.ext"
openssl x509 -req -in "$TMP/leaf.csr" -CA "$D/mongolive-test-ca.crt" -CAkey "$TMP/ca-key.pem" \
  -days 365 -out "$D/cert.pem" -extfile "$TMP/leaf.ext"

# 4. 인증기관 비밀키 파기 + 권한
shred -u "$TMP/ca-key.pem"; rm -rf "$TMP"
chmod 600 "$D/key.pem"; chmod 644 "$D/cert.pem" "$D/mongolive-test-ca.crt"

# 5. 확인
openssl verify -CAfile "$D/mongolive-test-ca.crt" "$D/cert.pem"          # → OK
openssl x509 -in "$D/mongolive-test-ca.crt" -noout -fingerprint -sha1     # 기기에 설치할 때 비교할 지문
```

### 접속하는 기기에 루트 인증서 설치

`~/.mongolive/tls/mongolive-test-ca.crt`(mkcert라면 `mkcert -CAROOT` 폴더의 `rootCA.pem`)를 기기로 옮겨 설치한다.
**공개 부분만 옮긴다.** mkcert의 `rootCA-key.pem` 같은 비밀키는 절대 옮기거나 공유하지 않는다.

**Windows** — 파일 더블클릭 → 인증서 설치 → 현재 사용자 → "모든 인증서를 다음 저장소에 저장" → **신뢰할 수 있는 루트 인증 기관** → 마침.
보안 경고에 나오는 지문이 위 5번 값과 같은지 확인한다. PowerShell로는:

```powershell
Import-Certificate -FilePath .\mongolive-test-ca.crt -CertStoreLocation Cert:\CurrentUser\Root
# 지우기
Get-ChildItem Cert:\CurrentUser\Root | Where-Object Subject -like '*MongoLive Test CA*' | Remove-Item
```

**Android** — 설정 → 보안 → 암호화 및 사용자 인증 정보 → 인증서 설치 → CA 인증서 (메뉴 이름은 기종마다 조금 다르다)

**iPhone** — 파일 열기 → 설정 → 다운로드된 프로파일 → 설치, 그다음 설정 → 일반 → 정보 → **인증서 신뢰 설정**에서 켠다(이 단계를 빼먹으면 경고가 계속 뜬다).

설치 후 브라우저를 완전히 껐다 켠다.

## 시험용: HTTP로 외부에 열기

같은 공유기 안에서 잠깐 시험할 때만.

```bash
HOST=0.0.0.0
ALLOW_INSECURE_HTTP=true
```

비밀번호와 로그인 쿠키가 암호화되지 않은 채 오간다. 같은 네트워크의 누구든 볼 수 있으므로 **실제 비밀번호를 쓰지 말고**, 끝나면 `set-password`로 바꾼다.

## 보안 설계 요약

| 막는 것 | 방법 |
|---|---|
| 비밀번호 파일 유출 | 비밀번호 자체가 아니라 scrypt(N=2¹⁷) 해시 + salt만 저장, 파일 권한 600 |
| 비밀번호 대입 | IP당 5번 실패 후 잠금(1분부터 두 배, 최대 1시간). 해시 계산은 한 번에 하나씩 |
| 출입증 위조 | 쿠키 = 만료 시각 + HMAC-SHA256 서명. 서버는 세션을 저장하지 않는다 |
| 출입증 탈취 | `HttpOnly`(페이지 스크립트가 못 읽음), HTTPS면 `Secure` |
| 다른 사이트가 몰래 보내는 요청(CSRF) | `SameSite=Strict` + 모든 요청의 Origin이 우리 주소와 같은지 검사 |
| 다른 사이트 페이지가 실시간 연결에 붙기 | WebSocket은 CORS를 따르지 않으므로 socket.io 연결에도 같은 Origin 검사 |
| 도청 | 외부에 열면서 HTTPS가 없으면 서버가 켜지지 않음 |
| 프록시 헤더 위조 | `TRUST_PROXY`일 때도 이 기기 안에서 온 연결의 헤더만, 그중 프록시가 붙인 마지막 값만 믿음 |
| 로그아웃·비밀번호 변경 뒤 남은 연결 | 실시간 연결도 1분마다 출입증을 다시 확인해 끊음 |

알고 있는 한계

- 혼자 쓰는 앱이라 계정이 하나(비밀번호 하나)다.
- 출입증을 서버에 저장하지 않으므로 기기 하나만 골라 로그아웃시킬 수는 없다. 모두 로그아웃은 `set-password`로.
- 이 기기에 로그인할 수 있는 사람(같은 OS 계정)은 믿는다. `~/.mongolive/auth.json`을 읽을 수 있으면 오프라인 대입이 가능하다.
- 로그인 잠금 기록은 메모리에만 있어 서버를 재시작하면 풀린다.

## 문제 해결

**인증서를 설치했는데도 "주의 요함"이 뜬다** — 설치 전에 경고 화면에서 "고급 → 계속"을 눌렀다면 브라우저가 그 결정을 기억하고 있다. 시크릿 창으로 열어 자물쇠가 뜨는지 보고, `chrome://restart`(Edge는 `edge://restart`)로 브라우저를 완전히 다시 켠다.

**서버가 "HTTPS가 없습니다"라며 안 켜진다** — `HOST`가 127.0.0.1이 아니면 외부에 열린다. A(127.0.0.1로 두기), B(프록시), C(인증서) 중 하나로 정한다.

**서버가 "비밀번호가 아직 없습니다"라며 안 켜진다** — `corepack pnpm set-password`.

**로그인 화면에서 "Too many attempts"** — 잠금 시간이 지나기를 기다리거나 서버를 재시작한다.
