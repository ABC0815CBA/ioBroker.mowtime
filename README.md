# ioBroker.mowtime

ioBroker-Adapter zur wochenweisen Optimierung der Mähzeit eines Worx-Mähroboters mit vier Zonen.

## Funktionsumfang

- Liest zwei Worx-Wochenkalender (`calJson`, `calJson2`) mit insgesamt 14 Mähslots.
- Jeder Slot kann in der Admin-Konfiguration als **Pflicht** oder **optional** markiert werden.
- Erfasst die reale Mähzeit je Zone anhand der Änderung von `mower.totalBladeTime` und `areas.actualArea`.
- Führt Ergebnisse unter `Results.actualWeek.zone1..4` und `Results.pastWeek.zone1..4`.
- Berechnet reale und gewünschte Mähzeit in Minuten und Prozent.
- Verschiebt beim Wechsel der ISO-Kalenderwoche `actualWeek` nach `pastWeek`.
- Setzt `control.MowtimeExtended` auf `0` oder `-100`.
- Unterstützt Regensperre über Open-Meteo oder einen ioBroker-Datenpunkt in mm/Tag.

## Entscheidungslogik

`MowtimeExtended = -100 %`, wenn:

1. alle vier Zonen ihre Wochen-Sollzeit erreicht haben, oder
2. die Regensperre aktiv ist, oder
3. der Mäher zuhause ist, aktuell nur ein optionales Zeitfenster läuft und die noch offenen Soll-Minuten vollständig in die verbleibenden Pflichtfenster passen.

Andernfalls ist `MowtimeExtended = 0 %`. Reichen die verbleibenden Pflichtfenster nicht mehr für die offene Wochenmähzeit, werden optionale Zeitfenster freigegeben.

## Regen

### ioBroker-Regensensor

Der konfigurierte Datenpunkt wird als kumulierter Wert `mm/Tag` interpretiert. Ändert er sich gegenüber dem zuletzt gemerkten Wert um mindestens `0,1 mm`, startet die Regensperre neu. Jede weitere Änderung um mindestens `0,1 mm` verlängert die Sperre erneut.

### Open-Meteo

Bei Open-Meteo werden die konfigurierten Koordinaten verwendet. Eine aktuelle Niederschlagsmenge von mindestens `0,1 mm` startet bzw. verlängert die Regensperre.

## Worx-Zonen

Worx `actualArea` wird intern so zugeordnet:

- `0` → Zone 1
- `1` → Zone 2
- `2` → Zone 3
- `3` → Zone 4

## Hinweis zur Zeiterfassung

Die Differenz von `totalBladeTime` wird der zuletzt bekannten Zone zugeschlagen. Dadurch wird beim gleichzeitigen Wechsel von `actualArea` und `totalBladeTime` bereits verstrichene Mähzeit nicht versehentlich der neuen Zone zugerechnet.

## Noch zu verifizieren

Die genaue ID des Worx-Datenpunkts, auf den `MowtimeExtended` geschrieben werden soll, ist installationsabhängig und deshalb in der Admin-Konfiguration frei einstellbar.

Die vier konfigurierten Zonen-Verhältnisse sind bereits als Konfiguration vorhanden. In der ersten Implementierung werden die vier Sollzeiten direkt zur Berechnung verwendet; eine automatische Ableitung der Sollzeiten aus einem Gesamtwert und den Verhältnissen kann als nächster Schritt ergänzt werden.
