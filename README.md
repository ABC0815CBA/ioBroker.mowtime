# ioBroker.mowtime

Steuert einen Worx-Landroid über den vorhandenen `worx`-Adapter anhand von Wetter,
simuliertem Graswachstum, Fläche, Boden und Schatten. **Version 0.1 ist ein
funktionsfähiger Prototyp und vor Veröffentlichung mit dem eigenen Mäher zu testen.**

## Funktion

- Liest `calendar.calJson` und `calendar.calJson2`; das Beispiel aus der
  Anforderung ergibt 270 Minuten Wochenplan.
- Ermittelt die seit Montag gemähte Zeit aus der Differenz von
  `mower.totalTime` zum gespeicherten Wochenanfangswert.
- Berechnet pro Zone den Bedarf als
  `Fläche × Wachstum × Bodenfaktor × Schattenfaktor` und wandelt ihn über die
  Mähleistung in Sollminuten um.
- Schreibt `mower.mowTimeExtend` im Bereich −100 bis +100 Prozent.
- Schreibt eine nach Zonenbedarf gewichtete JSON-Sequenz nach
  `areas.startSequence`.
- Sperrt bei Regen, zu viel Wind, zu niedriger Temperatur oder erreichtem
  Wochenziel. Nach einer Ziel-Sperre wird erst wieder freigegeben, wenn der neue
  Restbedarf mindestens `MinTime` beträgt (Hysterese).
- Unterstützt lokale ioBroker-Sensoren, Open-Meteo und Bright Sky/DWD. Die
  Internetdienste werden höchstens alle 15 Minuten ohne API-Schlüssel abgefragt.

## Installation zum Testen

1. Verzeichnis auf den ioBroker-Host kopieren.
2. Im ioBroker-Admin über „Adapter aus eigener URL“ installieren oder im
   ioBroker-Verzeichnis `iobroker url /pfad/zu/ioBroker.mowtime --host <host>`
   verwenden.
3. Instanz anlegen, Worx-Präfix und Zonen konfigurieren.
4. Zunächst die Worx-Schreibdatenpunkte beobachten und erst dann unbeaufsichtigt
   betreiben.

## Wachstumsmodell

Die Faktoren sind bewusst transparent in `lib/calculation.js` hinterlegt:

| Boden | Faktor | Schatten | Faktor |
|---|---:|---|---:|
| Sandig | 0,75 | Sonne | 1,00 |
| Sandig-Mischig | 0,85 | Halbschatten | 0,85 |
| Mischerde | 1,00 | Schatten | 0,70 |
| Humus | 1,10 | | |
| Humus-Lehm | 1,18 | | |
| Lehmig | 1,25 | | |

`Referenzwachstum` bezeichnet die Millimeter Wachstum, bei denen ein kompletter
Flächendurchgang angesetzt wird. Das Modell ist eine Heuristik, kein botanisches
Messmodell. In einer nächsten Version kann die Wachstumssimulation zusätzlich
aus Temperatur, Regen, Wind und Jahreszeit abgeleitet werden.

## Verhalten bei Internetausfall

Bei Open-Meteo oder Bright Sky wird der letzte erfolgreiche Wetterwert für die
konfigurierte Fehler-Toleranzzeit weiterverwendet. Ist er älter, schreibt der
Adapter `mower.mowTimeExtend = 0` und nimmt damit keinen Einfluss mehr auf die
Worx-Mähzeit. Der Regensensor und die interne Steuerung des Worx bleiben dann
maßgeblich. Ohne jemals erfolgreich empfangene Wetterdaten wird sofort auf
dieses neutrale Verhalten gewechselt. Diagnosewerte stehen unter `weather.*`.

Open-Meteo verlangt für die öffentliche, nichtkommerzielle API eine
Quellenangabe; Bright Sky liefert offene DWD-Daten. Es werden weder API-Key noch
Zahlungsdaten abgefragt.

## Wichtige Annahmen

- `totalTime` ist ein monoton steigender Absolutzähler in Stunden.
- `calJson` enthält je Wochentag `[Startzeit, DauerInMinuten, RandSchnitt]`.
- Die zweite Kalenderhälfte wird zur ersten addiert.
- `startSequence` akzeptiert beim Worx-Adapter einen JSON-String wie
  `[0,1,0,1]`. Falls die installierte Worx-Version einen nativen Arraywert
  verlangt, muss diese Schreibzeile entsprechend angepasst werden.
- Ein leerer Wetterdatenpunkt liefert einen sicheren Standardwert (kein Regen,
  kein Wind, 20 °C). Für sicherheitskritische Installationen sollte später eine
  „bei fehlendem Sensor sperren“-Option ergänzt werden.

## Vor einer öffentlichen Veröffentlichung

- Paketname, GitHub-URL und Autorendaten vervollständigen.
- Mit realen Worx-Datenpunkttypen testen, insbesondere `startSequence`.
- Übersetzungen, Adapter-Checker, Integrationstests und CI ergänzen.
- Lizenz- und Quellenhinweise für Open-Meteo und DWD in den finalen
  Veröffentlichungsmetadaten ergänzen.

## Tests

```sh
npm test
```

## Lizenz

MIT
