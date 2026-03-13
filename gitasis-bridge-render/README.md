# Gitasis Bridge

Gitasis Canlı Ekran verilerini Cloudflare Worker KV'ye sürekli aktarır.
Chrome veya Tampermonkey gerektirmez — 7/24 çalışır.

## Kurulum (Railway - Ücretsiz)

1. https://railway.app adresine git → GitHub ile giriş yap
2. "New Project" → "Deploy from GitHub repo" → bu klasörü yükle
3. **Environment Variables** ekle:
   - `GITASIS_USER` = Gitasis kullanıcı adın
   - `GITASIS_PASS` = Gitasis şifren
4. Deploy → Logları izle

## Loglar (normal çalışma)
```
✅ Login OK
✅ EIO handshake OK
✅ WebSocket connected!
👥 Users update: 11
📞 Calls update: 2
```

## Nasıl çalışır?
1. Gitasis'e login olur (session cookie alır)
2. Socket.IO üzerinden `canli_ekran_user_list_sonuc` ve `canli_ekran_info_list_sonuc` eventlerini dinler
3. Her event geldiğinde Cloudflare Worker KV'yi günceller
4. Wix sayfası Worker'dan 3 saniyede bir okur → canlı dashboard!

## Otomatik yeniden bağlanma
- WebSocket kopunca 10 saniye içinde yeniden bağlanır
- Her 6 saatte bir oturumu yeniler
- Railway platformu crash durumunda otomatik restart eder
