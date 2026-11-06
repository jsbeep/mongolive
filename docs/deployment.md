# 배포와 보안

mongolive 접속

## 한눈에

| 어디서 접속하나 | 방법 | 준비물 |
|---|---|---|
| 이 기기에서만 | [A. 기본 설정 그대로](#a-이-기기에서만-기본) | 없음 |
| 다른 기기에서도 (도메인 있음) | [B. 앞단 프록시가 HTTPS 맡기](#b-앞단-프록시가-https-맡기) | 도메인 + Caddy/nginx, 또는 Tailscale |
| 다른 기기에서도 (생 IP:포트) | [C. 서버가 직접 HTTPS](#c-서버가-직접-https) | 인증서 파일 |

**비밀번호 로그인 필수**
외부에 열면서 HTTPS 없으면 서버 안켜짐

## 공통: 처음 한 번

```bash
corepack pnpm install

# 1. MongoDB 주소 — replica set이어야함
cp apps/server/.env.example apps/server/.env
#    apps/server/.env 의 MONGODB_URI 채우기

# 2. 비밀번호 — 화면에 보이지 않게 입력받아 해시만 ~/.mongolive/auth.json(권한 600)에 저장
corepack pnpm set-password

# 3. 웹 화면 빌드
corepack pnpm build:web:remote

# 4. 실행
corepack pnpm start
```

- 비밀번호 바꾸기: `set-password` 재실행(모든 기기에서 로그아웃)

## A. 이 기기에서만 (기본)

`.env`의 `HOST=127.0.0.1`(기본값)
이건 털리면 어차피 다털린거임

`http://127.0.0.1:4000`

## B. 앞단 프록시가 HTTPS 맡기

프록시(Caddy, nginx, Tailscale serve 등)가 인증서 처리

```bash
# apps/server/.env
HOST=127.0.0.1        # 프록시만 붙을 수 있게
TRUST_PROXY=true      # 프록시가 붙여 주는 X-Forwarded-* 헤더를 믿는다
```

### Caddy

```caddy
mongo.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name mongo.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:4000;
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

## C. 서버가 직접 HTTPS

프록시 없이 `https://<IP>:4000`로 바로 접속할 때

```bash
# apps/server/.env
HOST=0.0.0.0
TLS_CERT=/home/me/.mongolive/tls/cert.pem
TLS_KEY=/home/me/.mongolive/tls/key.pem
```

### 테스트용 인증서 만들기 (openssl, 추가 설치 없음)

mkcert처럼 나만의 인증기관을 만들되, 두 가지를 더 해서 기기에 설치해도 위험이 적게

1. **이름 제한** — 이 인증기관은 아래 적은 이름으로만 인증서를 발급할 수 있다(`google.com` 같은 가짜 인증서 불가).
2. **비밀키 파기** — 서버 인증서를 하나 발급한 뒤 인증기관의 비밀키를 지운다. 이후로는 아무 인증서도 발급할 수 없다.

만료(1년)되거나 IP가 바뀌면 처음부터 다시 만들고 기기에도 다시 설치해야 함

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

`~/.mongolive/tls/mongolive-test-ca.crt`(mkcert라면 `mkcert -CAROOT` 폴더의 `rootCA.pem`)를 기기로 옮겨 설치
**공개 부분만 옮기기** mkcert의 `rootCA-key.pem` 같은 비밀키는 절대 옮기거나 공유 X

**Windows** — 파일 더블클릭 → 인증서 설치 → 현재 사용자 → "모든 인증서를 다음 저장소에 저장" → **신뢰할 수 있는 루트 인증 기관** → 마침.
보안 경고에 나오는 지문이 위 5번 값과 같은지 확인한다. PowerShell로는:

```powershell
Import-Certificate -FilePath .\mongolive-test-ca.crt -CertStoreLocation Cert:\CurrentUser\Root
# 지우기
Get-ChildItem Cert:\CurrentUser\Root | Where-Object Subject -like '*MongoLive Test CA*' | Remove-Item
```

**Android** — 설정 → 보안 → 암호화 및 사용자 인증 정보 → 인증서 설치 → CA 인증서

**iPhone** — 파일 열기 → 설정 → 다운로드된 프로파일 → 설치, 그다음 설정 → 일반 → 정보 → **인증서 신뢰 설정**

설치 후 브라우저 재시작

## 테스트: HTTP로 외부에 열기

같은 공유기 안에서 잠깐 시험할 때

```bash
HOST=0.0.0.0
ALLOW_INSECURE_HTTP=true
```

암호화 무시 모드

## 보안 설계 요약

| 막는 것 | 방법 |
|---|---|
| 비밀번호 파일 유출 | 비밀번호 자체가 아니라 scrypt(N=2¹⁷) 해시 + salt만 저장, 파일 권한 600 |
| 비밀번호 대입 | IP당 5번 실패 후 잠금(1분부터 두 배, 최대 1시간). 해시 계산은 한 번에 하나씩 |
| 출입증 위조 | 쿠키 = 만료 시각 + HMAC-SHA256 서명. 서버는 세션을 저장하지 않는다 |
| 출입증 탈취 | `HttpOnly`(페이지 스크립트가 못 읽음), HTTPS면 `Secure` |
| 다른 사이트가 몰래 보내는 요청(CSRF) | `SameSite=Strict` + 모든 요청의 Origin이 우리 주소와 같은지 검사 |
| 다른 사이트 페이지가 실시간 연결에 붙기 | WebSocket은 CORS를 따르지 않으므로 socket.io 연결에도 같은 Origin 검사 |
| 도청 | 외부에 열면서 HTTPS가 없으면 서버가 켜지지 않음(`ALLOW_INSECURE_HTTP` 미설정시) |
| 프록시 헤더 위조 | `TRUST_PROXY`일 때도 이 기기 안에서 온 연결의 헤더만, 그중 프록시가 붙인 마지막 값만 믿음 |
| 로그아웃·비밀번호 변경 뒤 남은 연결 | 실시간 연결도 1분마다 출입증을 다시 확인해 끊음 |

알고 있는 한계

- 혼자 쓰는 앱이라 계정이 하나(비밀번호 하나)다.
- 출입증을 서버에 저장하지 않으므로 기기 하나만 골라 로그아웃시킬 수는 없다. 모두 로그아웃은 `set-password`로.
- 이 기기에 로그인할 수 있는 사람(같은 OS 계정)은 믿는다. `~/.mongolive/auth.json`을 읽을 수 있으면 오프라인 대입이 가능하다.
- 로그인 잠금 기록은 메모리에만 있어 서버를 재시작하면 풀린다.

## 문제 해결

**인증서를 설치했는데도 "주의 요함"이 뜬다** — 설치 전에 경고 화면에서 "고급 → 계속"을 눌렀을 때.
시크릿 창으로 열어 자물쇠가 뜨는지 보고, `chrome://restart`(Edge는 `edge://restart`)로 브라우저 재시작

**"HTTPS가 없습니다"** — `HOST`가 127.0.0.1이 아니면 외부에 열린다. A(127.0.0.1로 두기), B(프록시), C(인증서) 중 하나로 정한다.

**"비밀번호가 아직 없습니다"** — `corepack pnpm set-password`.

**로그인 화면에서 "Too many attempts"** — 기다리거나 서버 재시작
