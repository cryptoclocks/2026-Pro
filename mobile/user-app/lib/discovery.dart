import 'package:multicast_dns/multicast_dns.dart';

class DiscoveredDevice {
  final String name; // ccp-xxxx
  final String host; // IP
  DiscoveredDevice(this.name, this.host);
}

/// Browse mDNS for CryptoClock displays (_ccp._tcp), ~4s window.
Stream<DiscoveredDevice> discoverDevices() async* {
  final client = MDnsClient();
  await client.start();
  try {
    await for (final ptr in client
        .lookup<PtrResourceRecord>(
          ResourceRecordQuery.serverPointer('_ccp._tcp.local'),
        )
        .timeout(const Duration(seconds: 4), onTimeout: (sink) => sink.close())) {
      await for (final srv in client.lookup<SrvResourceRecord>(
        ResourceRecordQuery.service(ptr.domainName),
      )) {
        await for (final ip in client.lookup<IPAddressResourceRecord>(
          ResourceRecordQuery.addressIPv4(srv.target),
        )) {
          final name = ptr.domainName.split('.').first;
          yield DiscoveredDevice(name, ip.address.address);
        }
      }
    }
  } finally {
    client.stop();
  }
}
