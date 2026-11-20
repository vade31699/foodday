# FOODAY on Render — PHP 8.3 under Apache.
#
# Render has no native PHP runtime, so the service runs this image. The document
# root is public/, whose single index.php front controller returns only the
# files the browser is meant to see (index.html, styles.css, app.js, the PWA
# icons, .well-known/assetlinks.json and api/*.php). .env, fooday.sql,
# README.md and tests/ are therefore never reachable over HTTP.
FROM php:8.3-apache

# The app talks to MySQL through PDO. OpenSSL (SMTP over TLS) and the JSON,
# mbstring and session extensions are already part of this image.
RUN docker-php-ext-install pdo_mysql

# Production PHP settings: errors go to the log rather than into JSON
# responses, and the upload ceilings clear the app's own 2 MB / 4 MB limits
# (a 4 MB image arrives base64-encoded, roughly a third larger on the wire).
COPY docker/php.ini /usr/local/etc/php/conf.d/fooday.ini

COPY docker/apache.conf /etc/apache2/sites-available/000-default.conf
COPY . /var/www/html

# Render shows the container's stdout and stderr in its log stream, while
# Apache writes to files by default. Pointing both at the container's streams
# means requests and error_log() lines are visible in the dashboard instead of
# being lost inside the container.
RUN ln -sf /dev/stdout /var/log/apache2/access.log \
    && ln -sf /dev/stderr /var/log/apache2/error.log

WORKDIR /var/www/html

EXPOSE 10000

# Render routes traffic to $PORT (10000 unless changed in the dashboard) while
# Apache listens on 80 by default, so both listens are rewritten at start-up.
CMD ["sh", "-c", "sed -ri \"s/^Listen 80$/Listen ${PORT:-10000}/\" /etc/apache2/ports.conf && sed -ri \"s/:80>/:${PORT:-10000}>/\" /etc/apache2/sites-available/000-default.conf && exec apache2-foreground"]
