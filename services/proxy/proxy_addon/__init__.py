"""Tremurex passive proxy addon (Phase 3).

A mitmproxy addon that *observes* responses and forwards JSON bodies of
monitored hosts to core's /ingest endpoint. It never modifies or blocks
traffic (CLAUDE.md §2 non-goals: passive capture only).
"""
