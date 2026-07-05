# TACTICA — Conqueror's Blade tactics playbook tool

Draw siege plans on real Conqueror's Blade maps as linear keyframe playbooks: place units,
sketch routes and zones, step through keyframes, play the tween, and export an animation
package (.zip). Plans persist in your browser (localStorage) and can be shared as read-only
links — nothing is stored server-side.

**Live:** https://jasperh2.github.io/tactica/

Vanilla ES modules, zero dependencies, no build step. To run locally, serve the folder with
any static server (ES modules don't load over `file://`):

```sh
python -m http.server 8123
# → http://localhost:8123/
```

## Notices

Non-commercial fan project. Conqueror's Blade and all in-game names, unit imagery, and map
layouts are the property of Booming Tech / MY.GAMES. Territory-war map imagery sourced from
community resource Elusive Guides. No affiliation; assets will be removed on request.
