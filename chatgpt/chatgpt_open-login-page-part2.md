
timwhite@tims-air SuperheroMode % git add .
timwhite@tims-air SuperheroMode % git commit -m fix
[production 84ee3ee] fix
 1 file changed, 1 insertion(+), 2 deletions(-)
timwhite@tims-air SuperheroMode % git push
Enumerating objects: 15, done.
Counting objects: 100% (15/15), done.
Delta compression using up to 8 threads
Compressing objects: 100% (8/8), done.
Writing objects: 100% (8/8), 716 bytes | 716.00 KiB/s, done.
Total 8 (delta 5), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (5/5), completed with 5 local objects.
To https://github.com/itstimwhite/SuperheroMode.git
   cdfda60..84ee3ee  production -> production
timwhite@tims-air SuperheroMode % git add .
timwhite@tims-air SuperheroMode % git commit -m typo
[production 0c1b02f] typo
 1 file changed, 1 insertion(+), 1 deletion(-)
timwhite@tims-air SuperheroMode % git push
Enumerating objects: 15, done.
Counting objects: 100% (15/15), done.
Delta compression using up to 8 threads
Compressing objects: 100% (8/8), done.
Writing objects: 100% (8/8), 683 bytes | 683.00 KiB/s, done.
Total 8 (delta 5), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (5/5), completed with 5 local objects.
To https://github.com/itstimwhite/SuperheroMode.git
   84ee3ee..0c1b02f  production -> production
timwhite@tims-air SuperheroMode % git add .         
timwhite@tims-air SuperheroMode % git commit -m typo
[production 2ce53ec] typo
 1 file changed, 2 insertions(+), 1 deletion(-)
timwhite@tims-air SuperheroMode % git push          
Enumerating objects: 15, done.
Counting objects: 100% (15/15), done.
Delta compression using up to 8 threads
Compressing objects: 100% (8/8), done.
Writing objects: 100% (8/8), 686 bytes | 686.00 KiB/s, done.
Total 8 (delta 5), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (5/5), completed with 5 local objects.
To https://github.com/itstimwhite/SuperheroMode.git
   0c1b02f..2ce53ec  production -> production
timwhite@tims-air SuperheroMode % vite build
zsh: command not found: vite
timwhite@tims-air SuperheroMode % npm run build

> build
> vite build

vite v4.5.0 building for production...
✓ 15 modules transformed.
✓ built in 228ms
[vite]: Rollup failed to resolve import "resources/js/Components/FitnessIcon.vue" from "/Users/timwhite/Documents/GitHub/SuperheroMode/resources/js/Pages/Profile/Partials/DietPhaseCard.vue".
This is most likely unintended because it can break your application at runtime.
If you do want to externalize this module explicitly add it to
`build.rollupOptions.external`
error during build:
Error: [vite]: Rollup failed to resolve import "resources/js/Components/FitnessIcon.vue" from "/Users/timwhite/Documents/GitHub/SuperheroMode/resources/js/Pages/Profile/Partials/DietPhaseCard.vue".
This is most likely unintended because it can break your application at runtime.
If you do want to externalize this module explicitly add it to
`build.rollupOptions.external`
    at viteWarn (file:///Users/timwhite/Documents/GitHub/SuperheroMode/node_modules/vite/dist/node/chunks/dep-bb8a8339.js:48216:27)
    at onRollupWarning (file:///Users/timwhite/Documents/GitHub/SuperheroMode/node_modules/vite/dist/node/chunks/dep-bb8a8339.js:48248:9)
    at onwarn (file:///Users/timwhite/Documents/GitHub/SuperheroMode/node_modules/vite/dist/node/chunks/dep-bb8a8339.js:47976:13)
    at file:///Users/timwhite/Documents/GitHub/SuperheroMode/node_modules/rollup/dist/es/shared/node-entry.js:24276:13
    at Object.logger [as onLog] (file:///Users/timwhite/Documents/GitHub/SuperheroMode/node_modules/rollup/dist/es/shared/node-entry.js:25950:9)
    at ModuleLoader.handleInvalidResolvedId (file:///Users/timwhite/Documents/GitHub/SuperheroMode/node_modules/rollup/dist/es/shared/node-entry.js:24862:26)
    at file:///Users/timwhite/Documents/GitHub/SuperheroMode/node_modules/rollup/dist/es/shared/node-entry.js:24822:26
timwhite@tims-air SuperheroMode % npm run build

> build
> vite build

vite v4.5.0 building for production...
✓ 795 modules transformed.
public/build/manifest.json                                     11.30 kB │ gzip:  1.22 kB
public/build/assets/DietPhaseCard-e3b0c442.css                  0.00 kB │ gzip:  0.02 kB
public/build/assets/Welcome-665689a9.css                        0.81 kB │ gzip:  0.30 kB
public/build/assets/app-e9b484e8.css                           35.67 kB │ gzip:  6.79 kB
public/build/assets/_plugin-vue_export-helper-c27b6911.js       0.09 kB │ gzip:  0.10 kB
public/build/assets/NewEntry-fcc5a48d.js                        0.34 kB │ gzip:  0.27 kB
public/build/assets/ApplicationLogo-2240c34d.js                 0.48 kB │ gzip:  0.36 kB
public/build/assets/PrimaryButton-d04ed1a5.js                   0.55 kB │ gzip:  0.37 kB
public/build/assets/GuestLayout-0c837acc.js                     0.64 kB │ gzip:  0.44 kB
public/build/assets/Import-f55c94e1.js                          0.73 kB │ gzip:  0.46 kB
public/build/assets/Create-d40cb5bb.js                          1.01 kB │ gzip:  0.61 kB
public/build/assets/TextInput-da9dada7.js                       1.04 kB │ gzip:  0.58 kB
public/build/assets/DietPlanner-d5554172.js                     1.10 kB │ gzip:  0.61 kB
public/build/assets/Edit-3171f232.js                            1.26 kB │ gzip:  0.66 kB
public/build/assets/ConfirmPassword-e3ce4011.js                 1.32 kB │ gzip:  0.75 kB
public/build/assets/ForgotPassword-6fff39cd.js                  1.51 kB │ gzip:  0.86 kB
public/build/assets/VerifyEmail-dfec490a.js                     1.57 kB │ gzip:  0.90 kB
public/build/assets/Welcome-3aaa536f.js                         1.81 kB │ gzip:  0.75 kB
public/build/assets/ResetPassword-0c0356bd.js                   2.08 kB │ gzip:  0.84 kB
public/build/assets/SecondaryButton-47c6d29b.js                 2.46 kB │ gzip:  1.06 kB
public/build/assets/Register-5d075296.js                        2.52 kB │ gzip:  0.96 kB
public/build/assets/DeleteUserForm-5195256c.js                  2.55 kB │ gzip:  1.24 kB
public/build/assets/UpdatePasswordForm-bbc45d4c.js              2.56 kB │ gzip:  0.99 kB
public/build/assets/Login-45caceab.js                           2.72 kB │ gzip:  1.27 kB
public/build/assets/DietPlannerContainer-e1f56baf.js            4.00 kB │ gzip:  1.44 kB
public/build/assets/UpdateProfileInformationForm-07b17683.js    4.37 kB │ gzip:  1.71 kB
public/build/assets/UserStats-0d76d821.js                       5.43 kB │ gzip:  2.10 kB
public/build/assets/Index-f0991acc.js                           5.49 kB │ gzip:  2.10 kB
public/build/assets/TrackBodyTable-a25f52ab.js                  6.88 kB │ gzip:  2.51 kB
public/build/assets/AuthenticatedLayout-c376996f.js             7.09 kB │ gzip:  2.30 kB
public/build/assets/DietPhaseCard-c537b2a9.js                  37.60 kB │ gzip: 15.64 kB
public/build/assets/Dashboard-26b16d2f.js                     170.21 kB │ gzip: 59.36 kB
public/build/assets/app-65318fe4.js                           208.31 kB │ gzip: 74.26 kB
✓ built in 1.66s
timwhite@tims-air SuperheroMode % git add .         
timwhite@tims-air SuperheroMode % git commit -m typo
[production cfece40] typo
 1 file changed, 1 insertion(+), 1 deletion(-)
timwhite@tims-air SuperheroMode % git push          
Enumerating objects: 15, done.
Counting objects: 100% (15/15), done.
Delta compression using up to 8 threads
Compressing objects: 100% (8/8), done.
Writing objects: 100% (8/8), 673 bytes | 673.00 KiB/s, done.
Total 8 (delta 5), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (5/5), completed with 5 local objects.
To https://github.com/itstimwhite/SuperheroMode.git
   2ce53ec..cfece40  production -> production
timwhite@tims-air SuperheroMode % git add .         
timwhite@tims-air SuperheroMode % git commit -m typo
[production d995d63] typo
 1 file changed, 1 insertion(+), 1 deletion(-)
timwhite@tims-air SuperheroMode % git push          
Enumerating objects: 11, done.
Counting objects: 100% (11/11), done.
Delta compression using up to 8 threads
Compressing objects: 100% (6/6), done.
Writing objects: 100% (6/6), 557 bytes | 557.00 KiB/s, done.
Total 6 (delta 4), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (4/4), completed with 4 local objects.
To https://github.com/itstimwhite/SuperheroMode.git
   cfece40..d995d63  production -> production
timwhite@tims-air SuperheroMode % git add .
timwhite@tims-air SuperheroMode % git commit -m typo
[production 914e95a] typo
 1 file changed, 1 insertion(+), 1 deletion(-)
timwhite@tims-air SuperheroMode % git push          
Enumerating objects: 15, done.
Counting objects: 100% (15/15), done.
Delta compression using up to 8 threads
Compressing objects: 100% (8/8), done.
Writing objects: 100% (8/8), 666 bytes | 666.00 KiB/s, done.
Total 8 (delta 5), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (5/5), completed with 5 local objects.
To https://github.com/itstimwhite/SuperheroMode.git
   d995d63..914e95a  production -> production
timwhite@tims-air SuperheroMode % git add .         
timwhite@tims-air SuperheroMode % git commit -m typo
[production 31c0796] typo
 1 file changed, 6 deletions(-)
timwhite@tims-air SuperheroMode % git push          
Enumerating objects: 11, done.
Counting objects: 100% (11/11), done.
Delta compression using up to 8 threads
Compressing objects: 100% (6/6), done.
Writing objects: 100% (6/6), 543 bytes | 543.00 KiB/s, done.
Total 6 (delta 4), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (4/4), completed with 4 local objects.
To https://github.com/itstimwhite/SuperheroMode.git
   914e95a..31c0796  production -> production
timwhite@tims-air SuperheroMode % git add .         
timwhite@tims-air SuperheroMode % git commit -m typo
[production e2a2f92] typo
 2 files changed, 1 insertion(+), 1 deletion(-)
 rename resources/js/{Components/FItnessIcon.vue => Pages/Profile/Partials/FitnessIcon.vue} (100%)
timwhite@tims-air SuperheroMode % git push          
Enumerating objects: 17, done.
Counting objects: 100% (17/17), done.
Delta compression using up to 8 threads
Compressing objects: 100% (9/9), done.
Writing objects: 100% (9/9), 897 bytes | 897.00 KiB/s, done.
Total 9 (delta 5), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (5/5), completed with 5 local objects.
To https://github.com/itstimwhite/SuperheroMode.git
   31c0796..e2a2f92  production -> production
timwhite@tims-air SuperheroMode % git add .         
timwhite@tims-air SuperheroMode % git commit -m typo
[production d41df8b] typo
 1 file changed, 1 insertion(+), 1 deletion(-)
timwhite@tims-air SuperheroMode % git push          
Enumerating objects: 15, done.
Counting objects: 100% (15/15), done.
Delta compression using up to 8 threads
Compressing objects: 100% (8/8), done.
Writing objects: 100% (8/8), 671 bytes | 671.00 KiB/s, done.
Total 8 (delta 5), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (5/5), completed with 5 local objects.
To https://github.com/itstimwhite/SuperheroMode.git
   e2a2f92..d41df8b  production -> production
timwhite@tims-air SuperheroMode % git add .         
timwhite@tims-air SuperheroMode % git commit -m yml
[production b1bf031] yml
 1 file changed, 2 insertions(+), 2 deletions(-)
timwhite@tims-air SuperheroMode % git push
Enumerating objects: 5, done.
Counting objects: 100% (5/5), done.
Delta compression using up to 8 threads
Compressing objects: 100% (3/3), done.
Writing objects: 100% (3/3), 313 bytes | 313.00 KiB/s, done.
Total 3 (delta 2), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (2/2), completed with 2 local objects.
To https://github.com/itstimwhite/SuperheroMode.git
   d41df8b..b1bf031  production -> production
timwhite@tims-air SuperheroMode % vapor deploy staging       
zsh: command not found: vapor
timwhite@tims-air SuperheroMode % vapor
zsh: command not found: vapor
timwhite@tims-air SuperheroMode % php vendor/bin/vapor deploy staging
The requested resource does not exist. Please ensure you are accessing the CLI with the correct team using the "team:current" command.
timwhite@tims-air SuperheroMode % php vendor/bin/vapor deploy production
Building project...
==> Validating Manifest File
==> Copying Application Files
==> Harmonizing Configuration Files
==> Setting Build Environment
==> Executing Build Commands
==> Running Command: COMPOSER_MIRROR_PATH_REPOS=1 composer install --no-dev
Installing dependencies from lock file
Verifying lock file contents can be installed on current platform.
Package operations: 0 installs, 0 updates, 37 removals
  - Removing theseer/tokenizer (1.2.2)
  - Removing spatie/laravel-ignition (2.3.1)
  - Removing spatie/ignition (1.11.3)
  - Removing spatie/flare-client-php (1.4.3)
  - Removing spatie/backtrace (1.5.3)
  - Removing sebastian/version (4.0.1)
  - Removing sebastian/type (4.0.0)
  - Removing sebastian/recursion-context (5.0.0)
  - Removing sebastian/object-reflector (3.0.0)
  - Removing sebastian/object-enumerator (5.0.0)
  - Removing sebastian/lines-of-code (2.0.1)
  - Removing sebastian/global-state (6.0.1)
  - Removing sebastian/exporter (5.1.1)
  - Removing sebastian/environment (6.0.1)
  - Removing sebastian/diff (5.0.3)
  - Removing sebastian/complexity (3.1.0)
  - Removing sebastian/comparator (5.0.1)
  - Removing sebastian/code-unit-reverse-lookup (3.0.0)
  - Removing sebastian/code-unit (2.0.0)
  - Removing sebastian/cli-parser (2.0.0)
  - Removing phpunit/phpunit (10.4.2)
  - Removing phpunit/php-timer (6.0.0)
  - Removing phpunit/php-text-template (3.0.1)
  - Removing phpunit/php-invoker (4.0.0)
  - Removing phpunit/php-file-iterator (4.1.0)
  - Removing phpunit/php-code-coverage (10.1.8)
  - Removing phar-io/version (3.2.1)
  - Removing phar-io/manifest (2.0.3)
  - Removing nunomaduro/collision (v7.10.0)
  - Removing myclabs/deep-copy (1.11.1)
  - Removing mockery/mockery (1.6.6)
  - Removing laravel/sail (v1.26.1)
  - Removing laravel/pint (v1.13.6)
  - Removing laravel/breeze (v1.26.1)
  - Removing hamcrest/hamcrest-php (v2.0.1)
  - Removing filp/whoops (2.15.4)
  - Removing fakerphp/faker (v1.23.0)
  0/27 [>---------------------------]   0%
 10/27 [==========>-----------------]  37%
 26/27 [==========================>-]  96%
 27/27 [============================] 100%
Generating optimized autoload files
> Illuminate\Foundation\ComposerScripts::postAutoloadDump
> @php artisan package:discover --ansi

   INFO  Discovering packages.  

  inertiajs/inertia-laravel ............................................. DONE
  laravel/sanctum ....................................................... DONE
  laravel/tinker ........................................................ DONE
  laravel/vapor-core .................................................... DONE
  nesbot/carbon ......................................................... DONE
  nunomaduro/termwind ................................................... DONE
  tightenco/ziggy ....................................................... DONE

57 packages you are using are looking for funding.
Use the `composer fund` command to find out more!
==> Running Command: php artisan event:cache

   INFO  Events cached successfully.  

==> Running Command: npm ci && npm run build && rm -rf node_modules

added 153 packages, and audited 154 packages in 2s

32 packages are looking for funding
  run `npm fund` for details

1 moderate severity vulnerability

To address all issues, run:
  npm audit fix

Run `npm audit` for details.

> build
> vite build

vite v4.5.0 building for production...
transforming...
✓ 794 modules transformed.
rendering chunks...
computing gzip size...
public/build/manifest.json                                     11.60 kB │ gzip:  1.25 kB
public/build/assets/Welcome-665689a9.css                        0.81 kB │ gzip:  0.30 kB
public/build/assets/app-ed00ed51.css                           35.07 kB │ gzip:  6.71 kB
public/build/assets/_plugin-vue_export-helper-c27b6911.js       0.09 kB │ gzip:  0.10 kB
public/build/assets/NewEntry-b656678b.js                        0.34 kB │ gzip:  0.27 kB
public/build/assets/ApplicationLogo-c37f07c6.js                 0.48 kB │ gzip:  0.36 kB
public/build/assets/PrimaryButton-92159ab5.js                   0.55 kB │ gzip:  0.37 kB
public/build/assets/GuestLayout-5969997f.js                     0.64 kB │ gzip:  0.44 kB
public/build/assets/Import-29e9d0df.js                          0.73 kB │ gzip:  0.46 kB
public/build/assets/Create-9b665fa6.js                          1.01 kB │ gzip:  0.60 kB
public/build/assets/TextInput-4a2fa4f7.js                       1.04 kB │ gzip:  0.58 kB
public/build/assets/DietPlanner-4d39b31d.js                     1.13 kB │ gzip:  0.62 kB
public/build/assets/Edit-81014ddd.js                            1.26 kB │ gzip:  0.66 kB
public/build/assets/ConfirmPassword-07a0ccbd.js                 1.32 kB │ gzip:  0.75 kB
public/build/assets/ForgotPassword-d26acef7.js                  1.51 kB │ gzip:  0.87 kB
public/build/assets/VerifyEmail-508fc0f5.js                     1.57 kB │ gzip:  0.90 kB
public/build/assets/Welcome-d49541d9.js                         1.81 kB │ gzip:  0.75 kB
public/build/assets/ResetPassword-868d22b9.js                   2.08 kB │ gzip:  0.84 kB
public/build/assets/SecondaryButton-9b43c8af.js                 2.46 kB │ gzip:  1.06 kB
public/build/assets/Register-8499ddbd.js                        2.52 kB │ gzip:  0.96 kB
public/build/assets/DeleteUserForm-f86ad5f7.js                  2.55 kB │ gzip:  1.24 kB
public/build/assets/UpdatePasswordForm-4fb7595c.js              2.56 kB │ gzip:  0.99 kB
public/build/assets/Login-02729303.js                           2.72 kB │ gzip:  1.27 kB
public/build/assets/DietPlannerContainer-0e225002.js            4.03 kB │ gzip:  1.45 kB
public/build/assets/UpdateProfileInformationForm-b2b174f9.js    4.38 kB │ gzip:  1.71 kB
public/build/assets/UserStats-d40bd7ce.js                       5.43 kB │ gzip:  2.10 kB
public/build/assets/Index-b39aa5dc.js                           5.49 kB │ gzip:  2.10 kB
public/build/assets/TrackBodyTable-6e8dbe99.js                  6.88 kB │ gzip:  2.51 kB
public/build/assets/AuthenticatedLayout-e0caa08e.js             7.09 kB │ gzip:  2.30 kB
public/build/assets/FitnessIcon-46c1a102.js                    15.87 kB │ gzip:  7.07 kB
public/build/assets/DietPhaseCard-6e4d27ee.js                  21.85 kB │ gzip:  8.21 kB
public/build/assets/Dashboard-69e52b61.js                     170.21 kB │ gzip: 59.36 kB
public/build/assets/app-1c109fbb.js                           208.55 kB │ gzip: 74.35 kB
✓ built in 1.87s
==> Running Command: php artisan migrate --force

In Connection.php line 822:
                                                                               
  SQLSTATE[HY000] [2002] Connection refused (Connection: mysql, SQL: select *  
   from information_schema.tables where table_schema = laravel and table_name  
   = migrations and table_type = 'BASE TABLE')                                 
                                                                               

In Connector.php line 65:
                                             
  SQLSTATE[HY000] [2002] Connection refused  
                                             


In Process.php line 269:
                                                                                      
  The command "php artisan migrate --force" failed.                                   
                                                                                      
  Exit Code: 1(General error)                                                         
                                                                                      
  Working directory: /Users/timwhite/Documents/GitHub/SuperheroMode/.vapor/build/app  
                                                                                      
  Output:                                                                             
  ================                                                                    
                                                                                      
  In Connection.php line 822:                                                         
                                                                                      
    SQLSTATE[HY000] [2002] Connection refused (Connection: mysql, SQL: select *       
     from information_schema.tables where table_schema = laravel and table_name       
     = migrations and table_type = 'BASE TABLE')                                      
                                                                                      
                                                                                      
  In Connector.php line 65:                                                           
                                                                                      
    SQLSTATE[HY000] [2002] Connection refused                                         
                                                                                      
                                                                                      
                                                                                      
                                                                                      
  Error Output:                                                                       
  ================                                                                    
                                                                                      

deploy [--commit [COMMIT]] [--message [MESSAGE]] [--without-waiting] [--fresh-assets] [--build-arg BUILD-ARG] [--build-option BUILD-OPTION] [--debug [DEBUG]] [--] [<environment>]

timwhite@tims-air SuperheroMode % 



The error you're encountering during the deployment process (`SQLSTATE[HY000] [2002] Connection refused`) indicates that your application is unable to establish a connection to the MySQL database. This is a common issue that can occur for various reasons, particularly in the context of deploying with Laravel Vapor. Here are some steps to troubleshoot and resolve this issue:

1. **Check Database Credentials**: Ensure that the database credentials in your Laravel application's configuration (`config/database.php` or the `.env` file) are correct. In the context of Laravel Vapor, these credentials are often set through environment variables. Make sure they are correctly set in the Vapor dashboard.

2. **Database Server Status**: Verify that the MySQL database server is running and accessible. If you're using a managed database service (like AWS RDS), check the database instance's status in the AWS Management Console.

3. **Network Access**: Ensure that your Vapor environment has network access to the database. This includes checking security groups, VPC settings, and any other network access controls that might be blocking connections from your application to the database server.

4. **Database URL Format**: In some cases, the format of the database URL or the way the credentials are passed can cause issues. Double-check the format and make sure it aligns with Laravel Vapor's expectations.

5. **Migrations and Artisan Commands**: Sometimes, issues can arise when running migrations or other Artisan commands during deployment. Test these commands locally to ensure they run without errors.

6. **Laravel Vapor Configuration**: Review your `vapor.yml` configuration file. Ensure that the build and deployment scripts are correctly set up and that the environment variables are properly configured.

7. **Environment Variables**: Sometimes, environment variables may not be passed correctly to the Vapor environment. Verify that all necessary environment variables are correctly set in the Vapor dashboard.

8. **Connection Timeout**: If the database server takes too long to respond (due to heavy load or other issues), it can also lead to a connection refusal. Check the server's performance and load.

9. **Logs and Debugging**: Check the logs provided by Laravel Vapor for more detailed error messages or clues. You can also enable debug mode to get more verbose output during deployment.

10. **Vapor CLI Tool**: Ensure that the Vapor CLI tool is correctly installed and configured on your local machine. The error `zsh: command not found: vapor` suggests that the Vapor CLI might not be properly installed or is not in your system's PATH.

11. **Consult Documentation**: Refer to the Laravel Vapor documentation and AWS (if using services like RDS) for specific guidance and best practices.

12. **Seek Support**: If the issue persists, consider reaching out to Laravel Vapor support or the Laravel community for assistance.

Resolving database connection issues often involves checking both the application configuration and the database server setup to ensure they are correctly aligned and can communicate with each other.
