# ioBroker.mowtime

Steuert einen Worx-Landroid über den vorhandenen `worx`-Adapter anhand von Wetter,
simuliertem Graswachstum, Fläche, Boden und Schatten. Der Adapter sollte vor
unbeaufsichtigtem Betrieb mit dem eigenen Mäher beobachtet werden.

## Funktion

- Liest `calendar.calJson` und `calendar.calJson2`; das Beispiel aus der
  Anforderung ergibt 270 Minuten Wochenplan.
- Ermittelt die seit Montag gemähte Zeit aus der Differenz von
  `mower.totalTime` zum gespeicherten Wochenanfangswert.
- Integriert das simulierte Wachstum dauerhaft je Teilfläche. Erreicht eine
  Teilfläche ihren mm-Schwellwert, wird ein vollständiger Auftrag für ihre Zone angelegt.
- Schreibt `mower.mowTimeExtend` im Bereich −100 bis +100 Prozent.
- Schreibt eine nach Zonenbedarf gewichtete JSON-Sequenz nach
  `areas.startSequence`.
- Sperrt bei Regen, zu viel Wind, zu niedriger Temperatur oder erreichtem
  Wochenziel. Nach einer Ziel-Sperre wird erst wieder freigegeben, wenn der neue
  Restbedarf mindestens `MinTime` beträgt (Hysterese).
- Unterstützt lokale ioBroker-Sensoren, Open-Meteo und Bright Sky/DWD. Die
  Internetdienste werden höchstens alle 15 Minuten ohne API-Schlüssel abgefragt.
- Wetterwerte werden in einem persistenten Stundenpuffer gemittelt bzw. summiert.
  Bodenwasser und Wachstum werden nur einmal je abgeschlossener Stunde verändert;
  die Regensperre bleibt unabhängig davon unmittelbar wirksam.
- Ein lokaler Regenwert darf ein Boolean oder eine Niederschlagsmenge in mm/10 min sein.
  `weather.raining` wird aktiv, wenn dieser Wert größer als der Grenzwert
  (standardmäßig 0,1 mm/10 min) ist. Die Tagesregenmenge steht in
  `weather.rainToday` in mm. Bei lokalen Sensoren kann hierfür der separate
  Datenpunkt `rainTodayState` konfiguriert werden.
  Temperatur, Regenmenge und Sonnenscheindauer werden als rollierende
  Sieben-Tage-Wetterhistorie gespeichert.
- Die über `areas.actualAreaIndicator` gemessene Zonenlaufzeit reduziert den
  offenen Auftrag. Nach einem vollständigen Zonendurchgang beginnt das Wachstum
  aller Teilflächen dieser Zone wieder bei 0 mm.

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

## Wachstumshistorie

`history.last7Days` enthält weiterhin alle Rohdetails als JSON. Zusätzlich werden
die letzten sieben abgeschlossenen Tage klar lesbar unter
`history.day0` bis `history.day6` abgelegt. Jeder Tag enthält für die vier
Worx-Zonen Datum, Sollzeit, gemessene Istzeit, Übertrag und Teilflächenergebnisse.
`day0` ist der jüngste abgeschlossene Tag.

## Teilflächen und Worx-Zonen

Worx-Zonen 0–3 sind ausschließlich technische Ziele für `startSequence`.
Biologische Eigenschaften werden in frei definierbaren Teilflächen gepflegt;
mehrere Teilflächen können derselben Worx-Zone zugeordnet sein. Pro Teilfläche
werden Fläche, Bodentextur, Fruchtbarkeit, Schatten, Wurzeltiefe, Regenfaktor,
optionale Bodenfeuchte sowie der Wachstumsschwellwert in Millimetern erfasst.

Das Teilflächenmodell führt über sieben Tageswerte eine Wasserbilanz aus
Niederschlag und FAO-Referenz-Evapotranspiration. Temperatur-, Licht-, Wasser-
und Fruchtbarkeitsfaktoren begrenzen das potenzielle Wachstum multiplikativ.
Der Bodenwasserspeicher beginnt bei der ersten Installation mit 70 Prozent und
wird danach je Teilfläche dauerhaft fortgeschrieben. Ist ET0 vorhanden, enthält
es den Windeinfluss bereits. Ohne ET0 schätzt der Adapter die Verdunstung aus
Temperatur, Sonnenschein und Wind.
Erreicht eine Teilfläche ihren Startwert, wird für die gesamte zugehörige Zone
ein Durchgang mit `Zonenfläche / Mähleistung × 60` Minuten angelegt. Der Auftrag
bleibt über Tagesgrenzen bestehen. Erst wenn die gemessene Laufzeit der Zone
seine Sollzeit erreicht, werden alle Teilflächen der Zone auf 0 mm zurückgesetzt.
Aus den verbleibenden Zonenzeiten wird die Zonenfolge erzeugt. Alte feste Zonenflächen werden automatisch als je eine
Teilfläche übernommen, solange noch keine neue Teilflächentabelle konfiguriert
ist.

Um 23 Uhr werden Ist- und Restzeiten dokumentiert. Die Zuordnung erfolgt über
`areas.actualAreaIndicator`; offene Zonenaufträge bleiben am Folgetag erhalten.
Die Zustände `zones.zone0` bis `zones.zone3` zeigen Soll-, Ist- und Restzeit des
jeweiligen Auftrags sowie die auslösende Teilfläche.

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
