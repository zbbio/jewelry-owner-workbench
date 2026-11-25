"""Ephemeral local TLS test setup, communicated only via child-process pipe."""
from datetime import datetime, timedelta, timezone
import json
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

name='n15-isolated.test'
key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
t=datetime.now(timezone.utc)
subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,name)])
c=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
   .serial_number(x509.random_serial_number()).not_valid_before(t-timedelta(minutes=1)).not_valid_after(t+timedelta(minutes=10))
   .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]),critical=False)
   .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True).sign(key,hashes.SHA256()))
print(json.dumps({'cert':c.public_bytes(serialization.Encoding.PEM).decode(),
 'key':key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()}))
