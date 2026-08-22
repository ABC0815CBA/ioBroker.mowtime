# ioBroker.mowtime

Ein ioBroker-Adapter, der `MowTimeExtended` eines Worx Landroid aus Regen, einem nachvollziehbaren Wachstumsmodell, den Ist-Mähzeiten je Zone und der noch verfügbaren Wochenplanzeit berechnet.

Der berechnete Ausgang steht unter `mowtime.0.Worx.MOwTimeExtended` sowie unter `mowtime.0.control.mowTimeExtended`. Optional schreibt der Adapter ihn zusätzlich in den auf der Admin-Seite ausgewählten originalen Worx-Datenpunkt.

## Funktionen

- Regensperre: Änderung eines kumulativen Regenzählers je Auswertungsintervall. Bei mehr als der konfigurierten Schwelle (Standard `0,1 mm/5 min`) wird `-100 %` gesetzt. Die Sperre endet nach der konfigurierten Trockenzeit (Standard 3 Stunden).
- Getrennte Schalter: Regensperre und Wetter-Wachstumsanpassung können unabhängig aktiviert werden. Aktiver Regen hat bei eingeschalteter Regensperre immer Vorrang und setzt `-100 %`. Liegt keine aktive Regensperre vor, ist der Ausgang bei ausgeschalteter Wetteranpassung immer `0 %`; nur bei eingeschalteter Wetteranpassung wird der berechnete Prognosewert ausgegeben.
- Wetterquellen: Regen, Temperatur, Bodenfeuchte und Licht können jeweils unabhängig aus einem eigenen ioBroker-Datenpunkt oder von Open-Meteo ohne API-Schlüssel bezogen werden. Sobald mindestens ein Wert Open-Meteo nutzt, werden Breitengrad und Längengrad benötigt; die Abfrage erfolgt standardmäßig höchstens einmal pro Stunde.
- 30-Tage-Modell: Temperatur und Licht sowie eine chronologische Bodenwasserbilanz werden ausgewertet. Die Bodenarten Sand, sandiger Lehm, Lehm/Mischboden und toniger Boden besitzen unterschiedliche Speicherkapazität, Versickerung und Infiltration. Regenzeitpunkte und Trockenpausen wirken dadurch anders als eine reine Regensumme.
- Wochensteuerung: Basis-Sollzeit je Zone × Wachstums-Multiplikator ergibt das Wochen-Soll. `totalTime` ist beim Worx-Adapter ein kumulativer Stundenzähler; seine positive Differenz wird mit 60 in Minuten umgerechnet und während eines konfigurierten Mähstatus der aktiven Zone zugerechnet. Technische Worx-Zonen werden dabei von `0–3` auf die angezeigten Zonen `1–4` abgebildet. Montag beginnt eine neue Bilanz.
- Kalenderprognose: Beide Worx-Wochenpläne (`calJson`, `calJson2`) liefern die ab jetzt noch geplanten Minuten. Daraus wird ein Wert von `-100 %` bis `+100 %` berechnet, der das verbleibende Defizit möglichst genau ausgleicht.
- Schreibbegrenzung: Die reguläre Berechnung läuft nur einmal je Lücke zwischen zwei Mähfenstern. Der externe Worx-Datenpunkt wird ausschließlich geschrieben, wenn sich der Prozentwert tatsächlich geändert hat. Die Regenprüfung bleibt im eingestellten Intervall aktiv und darf als Sicherheitsfunktion sofort `-100 %` setzen.

## Installation

Nach Veröffentlichung über die ioBroker-Adminoberfläche aus der GitHub-URL installieren oder im ioBroker-Host:

```sh
iobroker url https://github.com/ABC0815CBA/ioBroker.mowtime
```

Danach Instanz anlegen und auf der Konfigurationsseite die Datenpunkte auswählen. `rainStateId` muss kumulative Millimeter, `totalTimeStateId` kumulative Stunden und `zoneStateId` die technische Worx-Zonennummer 0–3 liefern.

Auf der Admin-Seite kann die Quelle für jeden Wetterwert einzeln gewählt werden. Bei Open-Meteo lädt der Adapter aktuellen Niederschlag sowie 30 Tage stündliche Temperatur, oberflächennahe Bodenfeuchte und Solarstrahlung. Bodenfeuchte wird von m³/m³ nach Prozent umgerechnet; Solarstrahlung wird mit `126,7 lx je W/m²` näherungsweise in Lux überführt. Der letzte erfolgreiche Abruf wird zwischengespeichert. Ohne jemals erfolgreich geladene benötigte Wetterdaten wird aus Sicherheitsgründen `-100 %` ausgegeben.

## Berechnung

Die Klima-Faktoren liegen jeweils zwischen 0 und 1. Bei Temperatur ≤5 °C oder ≥35 °C sowie extremer Trockenheit/Staunässe ist der entsprechende Faktor 0. Die Bodenart ist kein direkter Multiplikator, sondern bestimmt Wasserspeicher und Entwässerung:

`Multiplikator = Temperatur × Bodenwasserstress × Licht`

Bei Open-Meteo wird der Speicher mit 30 Tagen stündlichem Niederschlag und FAO-Referenzverdunstung fortgeschrieben. Bei einem eigenen Bodenfeuchte-Datenpunkt wird der Messwert direkt verwendet. Alte numerische Bodenwerte werden migriert: `0 = Sand`, `1 = Lehm/Mischboden`, `2 = toniger Boden`; keiner dieser Werte setzt das Wachstum pauschal auf null.

`MowTimeExtended = clamp((Rest-Soll / restliche Kalenderzeit - 1) × 100, -100, +100)`

Regen und ein bereits erreichtes Wochen-Soll überschreiben die Berechnung mit `-100 %`.

## Hinweise

- Die 30-Tage-Historie wird ab Adapterstart aufgebaut. Für belastbare Ergebnisse sollten die Wetterdatenpunkte regelmäßig aktualisiert werden.
- Bei Open-Meteo steht die 30-Tage-Historie sofort aus dem Wetterdienst zur Verfügung. Open-Meteo-Daten unterliegen dessen Lizenz- und Quellenhinweisen: https://open-meteo.com/
- Wenn `totalTime` zurückgesetzt wird, übernimmt der Adapter den neuen Basiswert ohne negative Mähzeit.
- Sprünge im Zähler werden je Intervall auf 60 Minuten begrenzt, um fehlerhafte Daten nicht ungeprüft zu übernehmen.

## Lizenz

MIT
