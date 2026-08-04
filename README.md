# Vaticinium

<p align="center"><img src="public/logo.svg" width="160" alt="Vaticinium Logo"/></p>

Ein vollständiges Wizard-Kartenspiel im Browser — Solo gegen KI oder Multiplayer mit Freunden über einen eigenen Node.js-Server.

![Lobby](docs/lobby.png)

## Features

- **Solo-Modus** — Spiel gegen 3 KI-Gegner mit adaptiver Bietstrategie und menschlichen Unschärfen
- **Multiplayer** — Echtzeit-Mehrspieler über Socket.io ohne Firebase oder externe Dienste
- **Late-Join** — Neue Spieler können einem laufenden Spiel beitreten und einen KI-Platz übernehmen
- **Tischchat** — Integrierter Echtzeit-Chat während des Spiels
- **Benutzerkonto (optional)** — Optionale Registrierung für browserübergreifende Spielstände und Hall of Fame
- **Cloud-Spielstand** — Eingeloggte Nutzer speichern ihren Fortschritt serverseitig und können auf jedem Gerät weiterspielen
- **Hall of Fame** — Serverweite Bestenliste; beim Sieg als eingeloggter Nutzer automatisch eingetragen
- **Highscore** — Lokale Bestenliste für Gäste (localStorage)
- **Responsive** — Funktioniert auf Desktop und Mobilgeräten

## Screenshots

### Solo-Modus
![Solo-Spiel](docs/solo.png)

### Multiplayer
![Multiplayer-Tisch](docs/multiplayer.png)

### Tisch erstellen
![Tisch erstellen](docs/tisch-erstellen.png)

### Warteraum
![Warteraum](docs/warteraum.png)

## Spielprinzip

Vaticinium basiert auf dem Wizard-Kartenspiel. Jede Runde sagt jeder Spieler vorher an, wie viele Stiche er machen wird — wer seine Ansage exakt trifft, punktet. Gespielt wird über 15 Runden (bei 4 Spielern).

**Karten:** 60 Karten in 4 Farben (Werte 1–13), 4 Zauberer (gewinnen immer) und 4 Narren (verlieren immer).

**Punkte:** Ansage korrekt → +20 + 10 pro Stich. Daneben getippt → −10 pro Differenz.

## Setup

### Voraussetzungen

- Node.js 18 oder neuer

### Installation

```bash
git clone https://github.com/noyse27/vaticinium.git
cd vaticinium
npm install
node server.js
```

Der Server startet auf Port 3000. Im Browser `http://localhost:3000` aufrufen.

### Port ändern

```bash
PORT=8080 node server.js
```

### Dauerhaft laufen lassen (z.B. Synology NAS)

```bash
# Mit PM2
npm install -g pm2
pm2 start server.js --name vaticinium
pm2 save
```

## Benutzerkonto

Ein Konto ist **optional** — das Spiel funktioniert ohne Registrierung vollständig.

**Ohne Konto (Gast):**
- Solo-Spiele laufen normal
- Spielstand wird im Browser-localStorage gespeichert
- Kein Eintrag in der Hall of Fame

**Mit Konto:**
- Spielstand wird serverseitig gespeichert (browserübergreifend)
- Beim Start eines Solo-Spiels wird der neuere Speicherstand (Server vs. lokal) angeboten
- Beim Sieg wird der Highscore automatisch in die Hall of Fame eingetragen
- Passwörter werden mit PBKDF2 (100.000 Iterationen, SHA-256, individueller Salt) gehasht

Konten werden über den `👤 Konto`-Button in der Lobby erstellt. Tokens werden in `localStorage` gespeichert und bleiben über Browser-Neustarts erhalten.

## Projektstruktur

```
vaticinium/
├── server.js        — Node.js-Server: Spiellogik, Socket.io, Auth, Tischverwaltung
├── package.json
├── data/            — Persistente Daten (users.json, saves.json, hall_of_fame.json)
├── docs/            — Screenshots
└── public/
    └── wizard.html  — Single-Page-App: Rendering, Solo-Logik, Auth-UI
```

## Multiplayer-Architektur

Der Server läuft als autoritäre Instanz — alle Spiellogik (Runden, KI-Züge, Stichauswertung, Punkteberechnung) läuft serverseitig. Clients senden nur Aktionen (`bid`, `play`) und rendern den empfangenen Zustand. Keine Race Conditions, kein Firebase.

```
Client A  ──┐                    ┌──  Client B
            ├──  Socket.io  ──── Server (Spiellogik)
Client C  ──┘                    └──  Client D
```

**Late-Join:** Beim Erstellen eines Tisches kann der Host „Nachträgliches Beitreten" aktivieren. Neue Spieler können dann während einer laufenden Partie einen KI-Platz übernehmen — die KI spielt die aktuelle Runde zu Ende, ab der nächsten Runde übernimmt der Mensch.

## Lizenz

MIT
