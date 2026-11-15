# Birlikte çalışma — Ayı Gördüm / MAXQMOON

## İlk anlaşma

Bu depo, mevcut Frost arayüzü ve gerçek DEM/SPICE hesabının ortak entegrasyon alanıdır.
3D motorunu geliştiren arkadaş mantığı kendi dalında geliştirsin; sonuç mevcut UI içine
React bileşeni olarak girsin. ZIP içindeki bağımsız uygulamayı komple kopyalayıp ana
uygulamanın yerine koymayın. Uzak/yörünge görünümü şu an kapsam dışı.

- `main`: birlikte kullanılabilir sürüm. Doğrudan push yerine PR.
- Dallar: `feat/compass-*`, `fix/shadow-*`, `feat/ui-*` gibi küçük, konu odaklı işler.
- Başlamadan `git fetch origin`, `git switch main`, `git pull --ff-only`, sonra yeni dal.
- Aynı dosyaya paralel iş başlamadan GitHub issue/PR yorumunda haber verin.
- `git push --force` kullanmayın. Başkasının değişikliğini silmeyin.
- PR'da amaç, değişen dosyalar, test komutları, ekran görüntüsü ve bilinen sınırlar yazılsın.
- Bu kurallar ekip anlaşmasıdır; GitHub branch protection ayarlanmış olduğu varsayılmaz.

## Dosya sahipliği ve entegrasyon sınırı

| Alan | Giriş noktası / dosyalar | Kural |
| --- | --- | --- |
| Uygulama kabuğu | `frontend/src/features/SkyView/MissionControl.tsx` | Konum, tarih, timeline, tema ve dialog durumunu burada tutun. Önceden haberleşmeden yeniden yazmayın. |
| Frost tasarımı | `frontend/src/features/SkyView/SkyView.css` | `--sv-*` değişkenlerini, açık/koyu temayı, shimmer ve mobil düzeni koruyun. |
| 2D grafik | `frontend/src/features/SkyView/SkyViewGraph.tsx`, `skyGeometry.ts` | Otomatik Y ölçeği, gerçek DEM ufku ve görünürlük etiketleri bozulmasın. |
| 3D motor | `frontend/src/features/SkyView/CompassView.tsx`, `compassTerrain.ts` | Arkadaşın öncelikli çalışma alanı. Aşağıdaki bileşen sözleşmesini koruyun. |
| API istemcisi | `frontend/src/services/skyview.ts` | Tek API katmanı; bileşenlerde yeni localhost URL'leri yazmayın. |
| Bilimsel backend | `backend/app/skyview.py`, `horizon.py`, `skyview_planning.py`, `skyview_router.py` | UI işi için değiştirmeyin. Bilimsel değişiklik ayrı PR ve gerekçe/test ister. |
| Eski uygulama | `frontend/src/App.tsx` ve diğer eski özellikler | Silmeyin; aktif giriş `frontend/src/index.tsx` içindeki MissionControl'dür. |

Tablodaki kısa dosya adları önceki hücredeki aynı klasördedir. Yeni ortak bir dosya
veya API alanı gerekiyorsa önce PR'da sözleşmesini netleştirin.

## 3D bileşen sözleşmesi

```tsx
export default function CompassView({ series, point }: {
  series: SkySeries;
  point: SkyPoint;
}) { /* ... */ }
```

Tipler `frontend/src/services/skyview.ts` içinden alınır.

- `series.site`: seçilmiş gerçek koordinat, DEM yüzey yüksekliği ve göz yüksekliği.
- `point`: timeline'da seçilmiş gerçek API örneği. Güneş/Dünya azimut, yükselim ve
  uzaklıkları buradan gelir. UI değişince motor aynı konumu/zamanı izlemeli.
- Ana kabuk 2D/3D geçişini yönetir; 3D bileşen kendi yaw/pitch/zoom durumunu yönetir.
- Zaman değişiminde renderer/DEM ağını baştan kurmayın. Işık/cisim yönlerini güncelleyin.
- Unmount/hata durumunda fetch, listener, ResizeObserver, texture, geometry, material
  ve WebGL kaynaklarını temizleyin. Sürekli boş render döngüsü çalıştırmayın.
- Sürükleme, ok tuşları, zoom, Güneş/Dünya odağı ve mobil dokunmayı koruyun.
- WebGL/veri yoksa açık hata gösterin; sahte arazi veya sessiz fallback kullanmayın.
- Üst seviye layout için UI dosyalarını değiştirmek yerine önce ihtiyaç bildirin.

## Bilimsel kurallar — değiştirmeden önce okuyun

1. Runtime'da mock, rastgele yörünge, sahte görünürlük veya uydurma krater yok.
   Sentetik fixture yalnızca testte kullanılabilir.
2. DEM ve SPICE aynı `MOON_ME_DE421` çerçevesindedir. `IAU_MOON` ile sessizce karıştırmayın.
3. Azimut kuzeyden saat yönünde; 0° kuzey, 90° doğu. Yükselim derece; uzaklık km.
   Yerel Three.js eksenleri: X doğu, Y yukarı, Z güney. Sahne uzunlukları metre.
4. Arazi 1:1 yükseklik ve Ay eğriliğiyle çizilir; 8× abartı bilimsel görünümde kullanılmaz.
5. Paket DEM 200 m aralıklı; 40 m kaynaktan seyreltilmiştir. 50 m mesh noktası üretmek
   yeni ölçüm veya 50 m doğruluk sağlamaz. Kapsam dışına arazi uydurmayın.
6. API görünürlüğü cisim merkezine ve örneklenmiş DEM ufkuna dayanır; enerji/iletişim
   garantisi değildir. Disk örtülmesi, atmosfer ve uçuş güvenliği modeli değildir.
7. Yalnız `normal · sunDirection` arazi gölgesi değildir. Dağ engellemesi için gerçek
   DEM gölge çözümü gerekir. Gölge çözünürlüğü, kapsaması, bias ve penumbra sınırları
   kullanıcıya dürüstçe açıklanmalı. Görsel gölge API sonucunu değiştirmesin.
8. Dünya evresi aynı yerel çerçevede `SunPosition - EarthPosition` yönüyle aydınlatılır.
   Rastgele 23.44° eğim eklemeyin. Dünya doku yönelimi şu an görseldir; SPICE attitude değil.
9. NASA/LROC haritası fotoğrafik ışık içerir; fiziksel albedo değildir. Kaynak/credit
   ve manifestleri koruyun. Dünya haritası statik, güncel bulut gözlemi değildir.
10. Eksik kernel/DEM: açık 503/422; başka nokta, tarih, frame veya veriyle sessiz ikame yok.

## Kurulum ve veri

Güncel çalıştırma rehberi: [docs/team/CURRENT_SETUP.md](docs/team/CURRENT_SETUP.md).
Kaynak ağaç, küçük veri artefaktları ve dokular Git içindedir. `node_modules`, build,
venv, `.env`, özel anahtarlar ve büyük ham DEM/kernel Git'e girmez.

`guncel3d.zip` yerel referanstır; içindeki `node_modules` ve kopya uygulama Git'e eklenmez.
İhtiyaç duyulan kaynak dosyası incelenip mevcut yapıya taşınmalı; bilinmeyen ZIP scriptleri
çalıştırılmamalı. Büyük ham veriler resmi kaynaktan kurulmalı; kaynağı ve hash'i kaydedilmeli.

## PR öncesi

```bash
cd frontend
npx tsc --noEmit
npm test -- --watchAll=false --runInBand --runTestsByPath src/features/SkyView/compassTerrain.test.ts src/features/SkyView/skyGeometry.test.ts
npm run build
```

Backend değiştiyse kökten:

```bash
python -m pytest backend/tests -q
```

Gerçek SPICE testleri kernel olmadan atlanabilir; raporda atlanan testleri belirtin.
Ayrıca `git diff --check` çalıştırın. Masaüstü ve 390 px mobil; açık/koyu tema; site
seçimi; timeline; 2D/3D geçişi; WebGL hatası; klavye ve kaynak temizliğini kontrol edin.
Gölge PR'ında aynı gerçek koordinat/zaman için gölge açık/kapalı görüntülerini ve
bilinen sınırları ekleyin. Geometri raycast testi tek başına GPU gölgesini doğrulamaz.

## Devralınan durum

- Frost UI, 33 katalog noktası, özel koordinat ve gerçek SPICE/DEM API mevcut.
- 3D pusula bağlı; ayrı Dünya aydınlatması ve sonlu DEM shadow map mevcut.
- Son kontrolde 16 frontend testi ve production build geçti.
- **GPU gölgesinin görsel doğruluğu henüz kesin doğrulanmadı.** İki gerçek sahnede
  aç/kapat karşılaştırması belirgin fark göstermedi. Bu sonuç motorun doğru olduğuna
  kanıt değildir; arkadaşın öncelikli inceleme konusu budur.
- Kutup UV kesiti düzeltildi; Dünya yönelimi ve LROC baked lighting sınırları sürüyor.

Yeni gelen arkadaş önce bu durumdan ilerlesin; yapılmamış şeyi tamamlandı diye sunmasın.
