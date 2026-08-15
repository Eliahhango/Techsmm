
  function toggleSidebar(){
    let main = document.getElementById('main_container');
     main.classList.toggle('toogle_sidebar');  
    }


 function toggleThemeMode(){
                        const techSMMCurrentMode = localStorage.getItem('techSMMCurrentMode');
                        const bodyFire = document.getElementById('body');

                        if(techSMMCurrentMode){
                                localStorage.removeItem('techSMMCurrentMode');
                                bodyFire.classList.remove('nightmode');
                        }else{
                                localStorage.setItem('techSMMCurrentMode', 'nightmode');
                                bodyFire.classList.add('nightmode');
                        }
                }

