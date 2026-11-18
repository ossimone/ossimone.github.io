# PDF Stüdyo

Tarayıcıda çalışan, tamamen istemci tarafında (client-side) PDF düzenleme uygulaması.
Dosyalar sunucuya yüklenmez; tüm işlemler kullanıcının cihazında yapılır.

## Yayın adresi
https://ossimone.github.io/

## Özellikler
- PDF görüntüleme, yakınlaştırma, sayfa yönetimi (sırala / sil / döndür / birleştir)
- Metin düzenleme: mevcut metni yerinde düzenleme, yazı tipi korunarak yeniden üretim
- Metin ekleme, taşıma, boyutlandırma
- Vurgulama, altı çizme, üstü çizme, kalem, dikdörtgen, not ekleme
- PDF olarak dışa aktarma
- Çevrimdışı çalışma (Service Worker) ve ana ekrana eklenebilir PWA

## Kullanım
1. https://ossimone.github.io/ adresini açın
2. "PDF Aç" ile bir dosya seçin
3. iPhone/iPad: Safari → Paylaş → **Ana Ekrana Ekle** ile uygulama ikonu oluşturun

## Yerel çalıştırma
```
python3 -m http.server 8765
```
Ardından http://localhost:8765 adresini açın.

## Teknolojiler
PDF.js, pdf-lib, fontkit, saf JavaScript (build adımı yok).
