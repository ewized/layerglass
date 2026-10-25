"""Bounded Bambu SSDP name lookup during an explicit camera scan."""

import ipaddress
import re
import select
import socket
import time
from urllib.parse import urlsplit


SERVICE = 'urn:bambulab-com:device:3dprinter:1'


def parse_announcement(packet, peer, networks):
    try:
        address = ipaddress.ip_address(peer)
        if not any(address in network for network in networks) or len(packet) > 8192:
            return None
        lines = packet.decode('utf-8').splitlines()
        if not lines or not (lines[0].startswith('NOTIFY ') or lines[0].startswith('HTTP/1.1 200')):
            return None
        headers = {key.lower().strip(): value.strip() for line in lines[1:] if ':' in line
                   for key, value in [line.split(':', 1)]}
        if headers.get('nt', headers.get('st')) != SERVICE:
            return None
        location = headers.get('location', peer)
        location = urlsplit(location).hostname if '://' in location else location
        if location != peer:
            return None
        result = {}
        for header, key in (('devname.bambu.com', 'name'), ('devmodel.bambu.com', 'model')):
            value = ''.join(character for character in headers.get(header, '') if character.isprintable()).strip()[:128]
            if value:
                result[key] = value
        serial = headers.get('usn', '').removeprefix('uuid:').split('::')[0]
        if re.fullmatch(r'[A-Za-z0-9]{6,64}', serial):
            result['serial'] = serial
        return result or None
    except (ValueError, UnicodeError):
        return None


def discover_names(networks, targets=(), stop_event=None, duration=2):
    if not networks:
        return {}
    sockets = []
    found = {}
    try:
        for port in (2021, 1900, 1990):
            connection = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                connection.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
                connection.bind(('', port))
                try:
                    connection.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                                          socket.inet_aton('239.255.255.250') + socket.inet_aton('0.0.0.0'))
                except OSError:
                    pass
                connection.setblocking(False)
                sockets.append(connection)
            except OSError:
                connection.close()
        request = (f'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\n'
                   f'MAN: "ssdp:discover"\r\nMX: 1\r\nST: {SERVICE}\r\n\r\n').encode()
        destinations = {'239.255.255.250', *(str(network.broadcast_address) for network in networks), *targets}
        for connection in sockets:
            for host in destinations:
                for port in (1900, 2021, 1990):
                    try:
                        connection.sendto(request, (host, port))
                    except OSError:
                        pass
        deadline = time.monotonic() + duration
        while sockets and time.monotonic() < deadline and not (stop_event and stop_event.is_set()):
            for connection in select.select(sockets, [], [], min(0.25, max(0, deadline - time.monotonic())))[0]:
                try:
                    packet, peer = connection.recvfrom(8193)
                    if metadata := parse_announcement(packet, peer[0], networks):
                        found[peer[0]] = metadata
                except OSError:
                    pass
        return found
    finally:
        for connection in sockets:
            connection.close()
